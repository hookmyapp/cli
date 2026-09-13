// Redirect CLI config/credentials reads+writes to an isolated temp directory
// so running `npm test` never clobbers the developer's real ~/.hookmyapp state.
// src/auth/store.ts and src/commands/workspace.ts honor HOOKMYAPP_CONFIG_DIR
// when set; we fork a fresh temp dir per vitest process.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.HOOKMYAPP_CONFIG_DIR) {
  process.env.HOOKMYAPP_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'hookmyapp-cli-test-'));
}

// Unset the credential env var for the whole suite. It is a supported auth
// mechanism (AIT-438), so a developer or CI runner may legitimately have one
// exported — and it outranks the stored credential, which silently flips every
// test that assumes "not logged in" or writes its own credentials.json. Tests
// that exercise the variable set it themselves.
delete process.env.HOOKMYAPP_API_KEY;

// Pin color output OFF for the whole suite. picocolors latches color support
// from process.stdout.isTTY at first import; several tests toggle isTTY to
// exercise interactive paths, which — combined with lazy dynamic imports —
// could latch color ON in a worker and make plain-string assertions on
// rendered output (e.g. `POST <url>`) flake. NO_COLOR forces picocolors off
// regardless of isTTY, matching the color-off state the assertions assume.
// (NO_COLOR disables; FORCE_COLOR would ENABLE, since picocolors only checks
// for the key's presence.)
process.env.NO_COLOR = '1';

