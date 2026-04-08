import { Command } from 'commander';
import { saveCredentials } from './store.js';
import { AuthError, NetworkError } from '../output/error.js';

const WORKOS_CLIENT_ID = process.env.HOOKMYAPP_WORKOS_CLIENT_ID ?? 'client_01KM5S4CGX9M2M2P63JTA6AFEH';

async function pollForTokens(opts: {
  clientId: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}): Promise<void> {
  const deadline = Date.now() + opts.expiresIn * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.interval * 1000));

    const res = await fetch('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: opts.deviceCode,
        client_id: opts.clientId,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      saveCredentials({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
      });
      console.log('\n✓ Logged in successfully\n\n→ Next, connect a WhatsApp account:\n  hookmyapp accounts connect\n');
      return;
    }

    const err = await res.json().catch(() => ({}));
    if (err.error === 'authorization_pending') {
      continue;
    }
    if (err.error === 'slow_down') {
      opts.interval += 5;
      continue;
    }

    // Unexpected error
    throw new AuthError('Login failed: ' + (err.error_description ?? err.error ?? 'unknown error'));
  }

  throw new AuthError('Login timed out. Try again: hookmyapp login');
}

export function loginCommand(program: Command): void {
  program
    .command('login')
    .description('Authenticate with HookMyApp via browser')
    .action(async () => {
      let res: Response;
      try {
        res = await fetch('https://api.workos.com/user_management/authorize/device', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
        });
      } catch {
        throw new NetworkError();
      }

      if (!res.ok) {
        throw new AuthError('Failed to initiate login. Try again later.');
      }

      const { device_code, user_code, verification_uri_complete, interval, expires_in } = await res.json();

      console.log(`\nOpening browser to authenticate...\nCode: ${user_code}\n`);

      // Integration-test hook: when set, write the verification URI to a file
      // so the integration suite can drive a headless browser through it.
      // No-op for real users (env var unset by default).
      if (process.env.HOOKMYAPP_LOGIN_URL_FILE) {
        const fs = await import('node:fs/promises');
        await fs.writeFile(process.env.HOOKMYAPP_LOGIN_URL_FILE, verification_uri_complete);
      }

      // Open browser
      const open = (await import('open')).default;
      await open(verification_uri_complete);

      await pollForTokens({
        clientId: WORKOS_CLIENT_ID,
        deviceCode: device_code,
        expiresIn: expires_in,
        interval,
      });
    });
}
