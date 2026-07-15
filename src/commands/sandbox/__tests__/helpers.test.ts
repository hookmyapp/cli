import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sessionIdentifier,
  sessionLabel,
  buildSandboxSendRequest,
} from '../helpers.js';
import type {
  WhatsAppSandboxSession,
  InstagramSandboxSession,
} from '../../../api/sandbox-session.js';

const wa: WhatsAppSandboxSession = {
  id: 'ssn_WA000001',
  type: 'whatsapp',
  whatsappPhone: '15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  sandboxPhoneNumberId: '1080996501762047',
  whatsappApiVersion: 'v24.0',
  accessToken: 'ACT_wa_xxx',
  hmacSecret: 'HMAC_wa',
  verifyToken: 'VT_test',
  status: 'active',
  origin: 'manual',
};

const igWithUsername: InstagramSandboxSession = {
  id: 'ssn_IG000001',
  type: 'instagram',
  senderInstagramId: '8745912038476523',
  accountInstagramId: '17841478719287768',
  senderInstagramUsername: 'ordvir',
  accessToken: 'ACT_ig_xxx',
  hmacSecret: 'HMAC_ig',
  verifyToken: 'VT_test',
  status: 'active',
  origin: 'demo_handoff',
};

const igWithoutUsername: InstagramSandboxSession = {
  ...igWithUsername,
  id: 'ssn_IG000002',
  senderInstagramUsername: null,
};

describe('sessionIdentifier', () => {
  it('renders +<phone> for WhatsApp', () => {
    expect(sessionIdentifier(wa)).toBe('+15551234567');
  });

  it('renders @<username> for Instagram when username is present', () => {
    expect(sessionIdentifier(igWithUsername)).toBe('@ordvir');
  });

  it('falls back to IGSID when Instagram username is null', () => {
    expect(sessionIdentifier(igWithoutUsername)).toBe('8745912038476523');
  });
});

describe('sessionLabel', () => {
  it('formats WhatsApp', () => {
    expect(sessionLabel(wa)).toBe('WhatsApp +15551234567 (active)');
  });

  it('formats Instagram with username', () => {
    expect(sessionLabel(igWithUsername)).toBe('Instagram @ordvir (active)');
  });

  it('formats Instagram without username (IGSID fallback)', () => {
    expect(sessionLabel(igWithoutUsername)).toBe(
      'Instagram 8745912038476523 (active)',
    );
  });
});

describe('buildSandboxSendRequest', () => {
  beforeEach(() => {
    process.env.HOOKMYAPP_SANDBOX_PROXY_URL = 'https://proxy.test';
  });
  afterEach(() => {
    delete process.env.HOOKMYAPP_SANDBOX_PROXY_URL;
  });

  it('builds the WhatsApp send URL using sandboxPhoneNumberId (not the tester phone)', () => {
    const { url } = buildSandboxSendRequest(wa, 'hi');
    expect(url).toBe('https://proxy.test/v24.0/1080996501762047/messages');
  });

  it('builds the WhatsApp send body in the WA shape', () => {
    const { body } = buildSandboxSendRequest(wa, 'hi');
    expect(body).toEqual({
      messaging_product: 'whatsapp',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi' },
    });
  });

  it('builds the Instagram send URL using accountInstagramId and v25.0', () => {
    const { url } = buildSandboxSendRequest(igWithUsername, 'hi');
    expect(url).toBe('https://proxy.test/v25.0/17841478719287768/messages');
  });

  it('builds the Instagram send body in the IG shape', () => {
    const { body } = buildSandboxSendRequest(igWithUsername, 'hello there');
    expect(body).toEqual({
      recipient: { id: '8745912038476523' },
      message: { text: 'hello there' },
    });
  });
});
