import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ messages: [{ id: 'wamid.X' }] })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import { runWhatsappMessagesSend } from '../whatsapp.js';
import { gatewayRequest } from '../../api/gateway.js';

describe('whatsapp messages send', () => {
  beforeEach(() => vi.mocked(gatewayRequest).mockClear());

  it('builds a text message body from --to/--text', async () => {
    await runWhatsappMessagesSend({ channel: '+15551234567', to: '+14441234567', text: 'hi' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{phone_number_id}/messages',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '+14441234567', type: 'text', text: { body: 'hi' } },
    }));
  });

  it('rejects mixing --text and --body', async () => {
    await expect(runWhatsappMessagesSend({ channel: '+1', to: '+2', text: 'hi', body: '{}' })).rejects.toThrow(/not both/);
  });

  it('passes a complete --body verbatim', async () => {
    await runWhatsappMessagesSend({ channel: '+1', body: '{"messaging_product":"whatsapp","to":"+2","type":"text","text":{"body":"x"}}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { messaging_product: 'whatsapp', to: '+2', type: 'text', text: { body: 'x' } },
    }));
  });

  it('accepts -d/--data as an alias for --body', async () => {
    await runWhatsappMessagesSend({ channel: '+1', data: '{"messaging_product":"whatsapp","to":"+2","type":"text","text":{"body":"x"}}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { messaging_product: 'whatsapp', to: '+2', type: 'text', text: { body: 'x' } },
    }));
  });
});
