-- Esquema inicial de InyectoresSantos.
--
-- Alcance deliberadamente mínimo: pausa del dueño, historial corto de
-- conversación, idempotencia de webhooks y estado de procesamiento. Nada más.
--
-- Ninguna tabla tiene políticas RLS: el acceso es exclusivamente del backend
-- con service_role, que las omite por diseño. Cualquier otro rol queda fuera.
--
-- NO EJECUTADA TODAVÍA. A partir de su primera aplicación, toda migración
-- posterior debe ser únicamente aditiva.

-- ---------------------------------------------------------------------------
-- Pausa por conversación
-- ---------------------------------------------------------------------------
create table if not exists public.chat_control (
  customer_phone        text primary key check (customer_phone ~ '^[0-9]{7,20}$'),
  -- Instante en que empezó la pausa vigente. Se conserva mientras la pausa no
  -- venza, aunque el dueño escriba varias veces seguidas.
  pause_started_at      timestamptz not null default now(),
  -- Vencimiento. Se renueva con cada mensaje manual del dueño y nunca se
  -- acorta, aunque los eventos lleguen fuera de orden.
  pause_expires_at      timestamptz not null,
  last_owner_message_id text not null,
  updated_at            timestamptz not null default now()
);

comment on table public.chat_control is
  'Pausa de la automatizacion en un solo chat tras una respuesta manual del dueno.';

-- ---------------------------------------------------------------------------
-- Idempotencia y estado de procesamiento de webhooks
-- ---------------------------------------------------------------------------
create table if not exists public.webhook_events (
  -- Cabecera X-Idempotency-Key de Kapso.
  event_id         text primary key,
  event_name       text not null,
  message_id       text not null,
  status           text not null check (status in ('processing', 'processed', 'failed')),
  -- Numero de veces que se tomo el evento. Kapso reintenta a los 10, 40 y 90
  -- segundos, asi que un evento sano no deberia pasar de cuatro.
  attempts         integer not null default 1 check (attempts > 0),
  -- Arrendamiento. Un evento 'processing' cuyo lease vencio quedo huerfano
  -- (timeout o caida) y se puede volver a tomar. Sin esto, un fallo
  -- transitorio convierte el mensaje del cliente en silencio permanente.
  lease_expires_at timestamptz not null default (now() + interval '60 seconds'),
  -- Id devuelto por Kapso cuando el mensaje ya salio. Mientras sea NULL, el
  -- evento es reclamable; en cuanto tiene valor, nunca mas, para no
  -- escribirle dos veces al mismo cliente.
  sent_message_id  text,
  -- Etiqueta corta del desenlace ('reply', 'silent:out_of_scope', ...).
  -- Nunca contiene el texto del cliente ni datos del proveedor.
  outcome          text check (outcome is null or char_length(outcome) <= 120),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  processed_at     timestamptz
);

comment on table public.webhook_events is
  'Idempotencia y arrendamiento de eventos de Kapso. Un evento entregado nunca se reprocesa.';

create index if not exists webhook_events_created_at_idx
  on public.webhook_events (created_at desc);

-- Para localizar eventos huerfanos durante el diagnostico.
create index if not exists webhook_events_recoverable_idx
  on public.webhook_events (status, lease_expires_at)
  where sent_message_id is null;

-- ---------------------------------------------------------------------------
-- Historial corto de conversación
-- ---------------------------------------------------------------------------
-- Solo lo necesario para entender un seguimiento como «¿y la segunda hasta
-- qué hora atiende?». No es un CRM ni un archivo histórico: se lee como
-- máximo la última media hora y se purga a las 24 horas.
create table if not exists public.conversation_messages (
  id             bigint generated always as identity primary key,
  customer_phone text not null check (customer_phone ~ '^[0-9]{7,20}$'),
  role           text not null check (role in ('customer', 'business')),
  body           text not null check (char_length(body) between 1 and 4096),
  -- Id del mensaje en WhatsApp, cuando existe. Evita duplicar un turno si el
  -- mismo evento se reprocesa.
  message_id     text,
  -- Qué decisión produjo un turno nuestro: 'reply' o 'clarify'.
  --
  -- Es lo único que permite saber si el último mensaje del negocio fue una
  -- aclaración y, por tanto, si se puede pedir otra. Sin esta columna,
  -- clarifyAllowed no se puede calcular a partir de datos persistidos.
  -- Siempre NULL en los turnos del cliente.
  business_action text,
  created_at     timestamptz not null default now(),
  constraint conversation_messages_business_action_ck check (
    (role = 'business' and business_action in ('reply', 'clarify'))
    or (role = 'customer' and business_action is null)
  )
);

comment on table public.conversation_messages is
  'Ventana corta de contexto. Sin payloads del proveedor, sin metadatos, sin secretos.';

create index if not exists conversation_messages_recent_idx
  on public.conversation_messages (customer_phone, created_at desc);

create unique index if not exists conversation_messages_message_id_key
  on public.conversation_messages (message_id)
  where message_id is not null;

-- ---------------------------------------------------------------------------
-- Toma recuperable de un evento
-- ---------------------------------------------------------------------------
-- Inserta el evento, o lo vuelve a tomar si quedó en 'failed' o si su
-- arrendamiento venció. Un evento ya entregado, o en curso y vigente, no se
-- toma. Es atómica: no hay ventana entre comprobar y escribir.
create or replace function public.claim_webhook_event(
  p_event_id      text,
  p_event_name    text,
  p_message_id    text,
  p_lease_seconds integer default 60
)
returns table (
  claimed              boolean,
  attempt_count        integer,
  current_status       text,
  delivered_message_id text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_event public.webhook_events%rowtype;
begin
  insert into public.webhook_events as e (
    event_id, event_name, message_id, status, attempts, lease_expires_at
  )
  values (
    p_event_id, p_event_name, p_message_id, 'processing', 1,
    now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (event_id) do update
    set status           = 'processing',
        attempts         = e.attempts + 1,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        outcome          = null,
        processed_at     = null,
        updated_at       = now()
    where e.sent_message_id is null
      and (
        e.status = 'failed'
        or (e.status = 'processing' and e.lease_expires_at < now())
      )
  returning * into v_event;

  if found then
    return query select true, v_event.attempts, v_event.status, v_event.sent_message_id;
    return;
  end if;

  select * into v_event
    from public.webhook_events w
   where w.event_id = p_event_id;

  return query select
    false,
    coalesce(v_event.attempts, 0),
    coalesce(v_event.status, 'unknown'),
    v_event.sent_message_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Renovación de la pausa del dueño
-- ---------------------------------------------------------------------------
-- Conserva el instante de inicio si la pausa seguía vigente y aplica GREATEST
-- sobre el vencimiento, de modo que un evento que llegue fuera de orden nunca
-- pueda acortar una pausa.
create or replace function public.renew_human_pause(
  p_customer_phone   text,
  p_owner_message_id text,
  p_minutes          integer
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now     timestamptz := now();
  v_until   timestamptz := now() + make_interval(mins => p_minutes);
  v_expires timestamptz;
begin
  insert into public.chat_control as c (
    customer_phone, pause_started_at, pause_expires_at, last_owner_message_id, updated_at
  )
  values (p_customer_phone, v_now, v_until, p_owner_message_id, v_now)
  on conflict (customer_phone) do update
    set pause_started_at      = case
                                  when c.pause_expires_at > v_now then c.pause_started_at
                                  else v_now
                                end,
        pause_expires_at      = greatest(c.pause_expires_at, v_until),
        last_owner_message_id = p_owner_message_id,
        updated_at            = v_now
  returning pause_expires_at into v_expires;

  return v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purga
-- ---------------------------------------------------------------------------
-- Sin cron ni servicios externos: el backend la invoca de forma oportunista.
-- Cuándo y con qué frecuencia se decide en la Fase 2.
create or replace function public.purge_expired_data(
  p_message_hours    integer default 24,
  p_event_days       integer default 7,
  p_pause_grace_days integer default 1
)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.conversation_messages
   where created_at < now() - make_interval(hours => p_message_hours);

  delete from public.webhook_events
   where created_at < now() - make_interval(days => p_event_days);

  delete from public.chat_control
   where pause_expires_at < now() - make_interval(days => p_pause_grace_days);
$$;

-- ---------------------------------------------------------------------------
-- Cierre de accesos
-- ---------------------------------------------------------------------------
alter table public.chat_control          enable row level security;
alter table public.webhook_events        enable row level security;
alter table public.conversation_messages enable row level security;

-- No se crea ninguna política. Sin políticas, RLS deniega todo a los roles
-- normales; solo service_role, que omite RLS, puede leer o escribir.

-- Defensa en profundidad: retirar además los permisos de tabla que Postgres
-- concede por defecto a los roles expuestos por PostgREST.
do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_catalog.pg_roles where rolname = v_role) then
      execute format(
        'revoke all on table public.chat_control, public.webhook_events, '
        || 'public.conversation_messages from %I', v_role);
    end if;
  end loop;
end;
$$;

revoke execute on function
  public.claim_webhook_event(text, text, text, integer),
  public.renew_human_pause(text, text, integer),
  public.purge_expired_data(integer, integer, integer)
from public;
