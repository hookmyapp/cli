const REQUIRED = [
  'E2E_PROVISION_SECRET',
  'E2E_ADMIN_EMAIL',
  'E2E_ADMIN_PASSWORD',
  'E2E_MEMBER_EMAIL',
  'E2E_MEMBER_PASSWORD',
  'E2E_API_BASE_URL',
] as const;

export type RequiredEnv = Record<(typeof REQUIRED)[number], string>;

export function assertEnv(): RequiredEnv {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[cli/test-integration] missing env vars: ${missing.join(', ')}. ` +
        `Local: source .env.e2e before running pnpm test:integration. ` +
        `pre-push-checks.sh handles this automatically.`,
    );
  }
  return Object.fromEntries(REQUIRED.map((k) => [k, process.env[k]!])) as RequiredEnv;
}

export const HOOKMYAPP_API_URL = 'http://localhost:4312';
export const HOOKMYAPP_WORKOS_CLIENT_ID =
  process.env.HOOKMYAPP_WORKOS_CLIENT_ID ?? 'client_01KM5S4CGX9M2M2P63JTA6AFEH';
