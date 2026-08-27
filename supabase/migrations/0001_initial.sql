create table if not exists public.chat_control (
  customer_phone text primary key check (customer_phone ~ '^[0-9]{7,20}$'),
  pause_expires_at timestamptz not null,
  last_owner_message_id text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  event_id text primary key,
  event_name text not null,
  message_id text not null,
  status text not null check (status in ('processing', 'processed', 'failed')),
  outcome text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.chat_control enable row level security;
alter table public.webhook_events enable row level security;

-- No se crean políticas públicas. Solo el backend con service_role puede leer
-- o escribir estas tablas.

create index if not exists webhook_events_created_at_idx
  on public.webhook_events (created_at desc);
