import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../../api/gateway.js', () => ({ gatewayRequest: vi.fn(async () => ({ data: [] })) }));
vi.mock('../_helpers.js', () => ({ resolveChannelRefOrDefault: vi.fn(async () => ({ id: 'ch_a', type: 'whatsapp', whatsappPhoneNumberId: '111', metaWabaId: '222', metaResourceId: '111', workspaceId: 'ws_1' })) }));

import {
  runWhatsappTemplatesList,
  runWhatsappTemplatesGet,
  runWhatsappTemplatesCreate,
  runWhatsappTemplatesDelete,
} from '../whatsapp-templates.js';
import { gatewayRequest } from '../../api/gateway.js';

describe('whatsapp templates', () => {
  beforeEach(() => vi.mocked(gatewayRequest).mockClear());

  it('lists templates with a WABA-scoped GET', async () => {
    await runWhatsappTemplatesList({ channel: '+1' });
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.path).toContain('{waba_id}/message_templates');
  });

  it('prints an empty-state line in human mode when there are no templates', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runWhatsappTemplatesList({ channel: '+1' });

    expect(writes.join('')).toContain('No templates yet.');
    spy.mockRestore();
  });

  it('appends list filters to the query', async () => {
    await runWhatsappTemplatesList({ channel: '+1', status: 'APPROVED', limit: '5' });
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.path).toContain('status=APPROVED');
    expect(call.path).toContain('limit=5');
  });

  it('gets a template by name', async () => {
    await runWhatsappTemplatesGet({ channel: '+1' }, 'hello_world');
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.method).toBe('GET');
    expect(call.path).toContain('name=hello_world');
  });

  it('creates a template from a complete --body', async () => {
    await runWhatsappTemplatesCreate({ channel: '+1', body: '{"name":"t1","category":"MARKETING"}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      body: { name: 't1', category: 'MARKETING' },
    }));
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.path).toContain('{waba_id}/message_templates');
  });

  it('accepts -d/--data as an alias for --body on create', async () => {
    await runWhatsappTemplatesCreate({ channel: '+1', data: '{"name":"t1","category":"MARKETING"}' });
    expect(gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({
      body: { name: 't1', category: 'MARKETING' },
    }));
  });

  it('rejects create with no --body/--data with a MISSING_BODY error', async () => {
    await expect(runWhatsappTemplatesCreate({ channel: '+1' })).rejects.toThrow(/requires --body/);
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it('deletes a template by name with method DELETE', async () => {
    await runWhatsappTemplatesDelete({ channel: '+1' }, 'hello_world');
    const call = vi.mocked(gatewayRequest).mock.calls[0][0];
    expect(call.method).toBe('DELETE');
    expect(call.path).toContain('name=hello_world');
  });
});
