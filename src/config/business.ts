/**
 * ÚNICO archivo que hay que editar para cambiar lo que responde el negocio.
 *
 * Los textos están vacíos a propósito: el sistema no debe mandar información
 * inventada. Completa las cuatro respuestas y después activa
 * BUSINESS_RESPONSES_ENABLED=true en Vercel.
 */
export const BUSINESS_RESPONSES = {
  services: '',
  hours: '',
  location: '',
  information: '',
} as const;

export type BusinessIntent = keyof typeof BUSINESS_RESPONSES;
