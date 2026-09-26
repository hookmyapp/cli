import { afterEach, describe, expect, it } from 'vitest';
import { channelKinds, facebookVisible } from '../facebook-preview.js';

describe('facebook preview switch', () => {
  const saved = process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
  afterEach(() => {
    if (saved === undefined) delete process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
    else process.env.HOOKMYAPP_FACEBOOK_PREVIEW = saved;
  });

  it('shows Facebook everywhere now that Facebook Pages is live', () => {
    delete process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
    expect(facebookVisible()).toBe(true);
    expect(channelKinds()).toBe('WhatsApp, Instagram & Facebook');
    expect(channelKinds('or')).toBe('WhatsApp, Instagram or Facebook');
  });
});
