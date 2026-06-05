import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ success: true })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import { runWhatsappMessagesRead } from '../whatsapp.js';
import { gatewayRequest } from '../../api/gateway.js';

describe('whatsapp messages read', () => {
  beforeEach(() => vi.mocked(gatewayRequest).mockClear());

  it('marks a message as read with the read-status body', async () => {
    await runWhatsappMessagesRead({ channel: '+1' }, 'wamid.ABC');
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST', path: '/{phone_number_id}/messages',
      body: { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.ABC' },
    }));
  });
});
