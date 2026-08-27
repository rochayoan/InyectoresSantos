function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

export function getEnv() {
  const pause = Number(process.env.HUMAN_PAUSE_MINUTES ?? '30');
  if (!Number.isFinite(pause) || pause <= 0 || pause > 1440) {
    throw new Error('invalid_env:HUMAN_PAUSE_MINUTES');
  }

  return {
    kapsoApiKey: required('KAPSO_API_KEY'),
    kapsoPhoneNumberId: required('KAPSO_PHONE_NUMBER_ID'),
    kapsoWebhookSecret: required('KAPSO_WEBHOOK_SECRET'),
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    responsesEnabled: process.env.BUSINESS_RESPONSES_ENABLED === 'true',
    humanPauseMinutes: pause,
  };
}
