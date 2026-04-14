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
