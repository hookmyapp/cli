import { describe, it, expect } from 'vitest';
import { parseChannelListItem } from '../api/channel.js';
import { substitutePath } from '../api/gateway.js';
import { channelLabel } from '../commands/channels.js';

const base = {
  id: 'ch_FBaaaaaa', workspaceId: 'ws_TEST0001', metaWabaId: null, metaResourceId: '100000000000001',
  connectionType: 'facebook_login', metaConnected: true, forwardingEnabled: true, webhookUrl: null, verifyToken: null,
};

describe('facebook channel model', () => {
  it('parses a facebook row with its Page fields and labels it "Facebook <name>"', () => {
    const ch = parseChannelListItem({ ...base, type: 'facebook', facebookPageName: 'Acme', facebookPagePictureUrl: null });
    expect(ch.type).toBe('facebook');
    expect(channelLabel(ch)).toBe('Facebook Acme');
  });

  it('maps the legacy "messenger" type from an older backend to facebook with null Page fields', () => {
    const ch = parseChannelListItem({ ...base, type: 'messenger' });
    expect(ch).toMatchObject({ type: 'facebook', facebookPageName: null, facebookPagePictureUrl: null });
    expect(channelLabel(ch)).toBe('Facebook ch_FBaaaaaa');
  });

  it('rejects a non-string facebookPageName', () => {
    expect(() => parseChannelListItem({ ...base, type: 'facebook', facebookPageName: 7 })).toThrow(/facebookPageName/);
  });

  it('fills {page_id} from the Page id and refuses it on other types', () => {
    const fb = parseChannelListItem({ ...base, type: 'facebook', facebookPageName: 'Acme', facebookPagePictureUrl: null });
    expect(substitutePath('/{page_id}/feed', fb)).toBe('/100000000000001/feed');
    const ig = parseChannelListItem({ ...base, type: 'instagram', instagramUsername: 'a', instagramProfileName: null, instagramProfilePictureUrl: null });
    expect(() => substitutePath('/{page_id}/feed', ig)).toThrow(/page_id/);
  });
});
