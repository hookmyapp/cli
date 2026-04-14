import { describe, it, expect } from 'vitest';
import { summarize } from '../../commands/sandbox-listen/summarizer.js';

describe('summarize', () => {
  it('extracts text message sender from Meta webhook payload', () => {
    const payload = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ type: 'text', from: '972501234567', text: { body: 'hi' } }],
                },
              },
            ],
          },
        ],
      }),
    );
    const line = summarize(payload);
    expect(line).toBe('text_message from 972501234567');
  });

  it('extracts reaction message', () => {
    const payload = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ type: 'reaction', from: '972501234567', reaction: { emoji: '👍' } }],
                },
              },
            ],
          },
        ],
      }),
    );
    expect(summarize(payload)).toBe('reaction_message from 972501234567');
  });

  it('extracts image message', () => {
    const payload = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [{ type: 'image', from: '15551234567', image: { id: 'xyz' } }],
                },
              },
            ],
          },
        ],
      }),
    );
    expect(summarize(payload)).toBe('image_message from 15551234567');
  });

  it('extracts status from statuses array', () => {
    const payload = Buffer.from(
      JSON.stringify({
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ status: 'delivered', recipient_id: '972501234567' }],
                },
              },
            ],
          },
        ],
      }),
    );
    expect(summarize(payload)).toBe('delivered from 972501234567');
  });

  it('falls back to byte count on malformed JSON', () => {
    const payload = Buffer.from('!!! this is not json {{{');
    const line = summarize(payload);
    expect(line).toBe(`POST /webhook (${payload.length} bytes)`);
  });

  it('falls back to byte count on empty buffer', () => {
    const payload = Buffer.alloc(0);
    expect(() => summarize(payload)).not.toThrow();
    expect(summarize(payload)).toBe('POST /webhook (0 bytes)');
  });

  it('falls back when JSON is valid but lacks known shapes', () => {
    const payload = Buffer.from(JSON.stringify({ unexpected: 'shape', foo: 42 }));
    expect(summarize(payload)).toBe(`POST /webhook (${payload.length} bytes)`);
  });
});
