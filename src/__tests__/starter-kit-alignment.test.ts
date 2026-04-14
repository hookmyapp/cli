import { describe, test, expect, beforeAll } from 'vitest';

const STARTER_KIT_ENV_URL =
  'https://raw.githubusercontent.com/hookmyapp/webhook-starter-kit/main/.env.example';

const CLI_CANONICAL_KEYS = [
  'PORT',
  'VERIFY_TOKEN',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_API_URL',
  'WHATSAPP_PHONE_NUMBER_ID',
];

let starterEnv: string;

beforeAll(async () => {
  const res = await fetch(STARTER_KIT_ENV_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${STARTER_KIT_ENV_URL}: ${res.status} ${res.statusText}`,
    );
  }
  starterEnv = await res.text();
}, 30_000);

describe('Cross-repo drift: starter-kit .env.example ≡ CLI canonical env block', () => {
  test('key-set matches CLI canonical set', () => {
    const keys = starterEnv
      .split('\n')
      .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
      .map((l) => l.split('=')[0])
      .sort();
    expect(keys).toEqual([...CLI_CANONICAL_KEYS].sort());
  });

  test('has no NGROK_* keys', () => {
    expect(starterEnv).not.toMatch(/^NGROK_/m);
  });

  test('comment points users at `hookmyapp sandbox env`', () => {
    expect(starterEnv).toMatch(/hookmyapp sandbox env/);
  });

  test('VERIFY_TOKEN is not hard-coded to the old `hookmyapp-verify` default', () => {
    expect(starterEnv).not.toMatch(/^VERIFY_TOKEN=hookmyapp-verify\s*$/m);
  });
});
