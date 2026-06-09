import { describe, it, expect } from 'vitest';
import { renderRow } from '../../commands/channels-listen/picker.js';
import type { WhatsAppChannel } from '../../api/channel.js';

// Two numbers on ONE WABA: identical whatsappWabaName + identical metaWabaId,
// distinct whatsappDisplayPhoneNumber + whatsappPhoneNumberId. This is the
// exact shape backend Plan 4 produces for a second number on an existing WABA.
const WABA_SENTINEL = 'WABA_SENTINEL_99999';

function waNumber(over: Partial<WhatsAppChannel>): WhatsAppChannel {
  return {
    id: 'ch_NUMBER01',
    type: 'whatsapp',
    workspaceId: 'ws_TEST0010',
    metaWabaId: WABA_SENTINEL,
    metaResourceId: WABA_SENTINEL,
    connectionType: 'embedded_signup',
    metaConnected: true,
    forwardingEnabled: true,
    webhookUrl: null,
    verifyToken: null,
    whatsappWabaName: 'Acme Co',
    whatsappDisplayPhoneNumber: '+1 555-111-1111',
    whatsappPhoneNumberId: 'pn_AAA',
    whatsappVerifiedName: null,
    whatsappQualityRating: null,
    ...over,
  };
}

describe('renderRow — two numbers on one WABA', () => {
  const numberOne = waNumber({ id: 'ch_NUMBER01', whatsappDisplayPhoneNumber: '+1 555-111-1111', whatsappPhoneNumberId: 'pn_AAA' });
  const numberTwo = waNumber({ id: 'ch_NUMBER02', whatsappDisplayPhoneNumber: '+1 555-222-2222', whatsappPhoneNumberId: 'pn_BBB' });

  it('When two channels share a WABA name, then their rows differ by phone', () => {
    expect(renderRow(numberOne)).not.toBe(renderRow(numberTwo));
    expect(renderRow(numberOne)).toContain('+1 555-111-1111');
    expect(renderRow(numberTwo)).toContain('+1 555-222-2222');
  });

  it('When rendering a WhatsApp row, then the WABA id never appears', () => {
    expect(renderRow(numberOne)).not.toContain(WABA_SENTINEL);
  });
});
