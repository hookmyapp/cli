// B10 — IG banner copy.
//
// Mirrors src/commands/__tests__/sandbox-listen-banner.test.ts in style but
// targets the channels-listen banner with an InstagramChannel fixture. The
// goal is to lock in the type-aware label (`Instagram @<handle>`) so a
// future refactor that reverts to a WA-shaped pluck (e.g. whatsappDisplayPhoneNumber
// fall-through) regresses visibly. WA + Messenger arms are exercised by
// integration tests (channels-listen.test.ts + wizard.test.ts).
import { describe, it, expect, vi } from 'vitest';
import { printBanner } from '../index.js';
import type { Channel } from '../../../api/channel.js';

const ig: Channel = {
  id: 'ch_IGaaaaaa',
  type: 'instagram',
  workspaceId: 'ws_TEST0001',
  metaWabaId: '',
  metaResourceId: '17841',
  connectionType: 'instagram_login',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: null,
  instagramUsername: 'ordvir',
  instagramProfileName: 'Or',
  instagramProfilePictureUrl: null,
};

describe('channels listen — IG banner copy', () => {
  it('prints "Instagram @ordvir" + tunnel URL', () => {
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    printBanner({
      hostname: 'abc.cloudflare.example',
      localPort: 3000,
      path: '/webhook',
      channel: ig,
      json: false,
    });
    const combined = outSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toContain('Instagram @ordvir');
    expect(combined).toContain('abc.cloudflare.example');
    expect(combined).not.toContain('WhatsApp');
    outSpy.mockRestore();
  });
});
