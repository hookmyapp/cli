import { describe, it, expect } from 'vitest';
import {
  parseChannelListItem,
  parseChannelDetail,
  type Channel,
  type ChannelDetail,
} from '../channel.js';
import { UnexpectedError } from '../../output/error.js';

const baseValidWa = {
  id: 'ch_WAaaaaaa',
  type: 'whatsapp',
  workspaceId: 'ws_aaaaaaa',
  metaWabaId: '1179304900593762',
  metaResourceId: '1080996501762047',
  connectionType: 'cloud_api',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: 'https://my.example/hook',
  verifyToken: 'vt_xxx',
  whatsappWabaName: 'My WABA',
  whatsappDisplayPhoneNumber: '+15551234567',
  whatsappPhoneNumberId: '1080996501762047',
  whatsappVerifiedName: 'Test Co.',
  whatsappQualityRating: 'GREEN',
  whatsappQualityRatingCheckedAt: '2026-05-26T12:00:00Z',
};

const baseValidIg = {
  id: 'ch_IGaaaaaa',
  type: 'instagram',
  workspaceId: 'ws_aaaaaaa',
  metaWabaId: '',
  metaResourceId: '17841478719287768',
  connectionType: 'instagram_login',
  metaConnected: true,
  forwardingEnabled: true,
  webhookUrl: null,
  verifyToken: 'vt_yyy',
  instagramUsername: 'ordvir',
  instagramProfileName: 'Or Dvir',
  instagramProfilePictureUrl: 'https://cdninstagram.com/...',
};

describe('parseChannelListItem', () => {
  it('parses a valid WhatsApp list-item', () => {
    const out: Channel = parseChannelListItem(baseValidWa);
    expect(out.type).toBe('whatsapp');
    if (out.type === 'whatsapp') {
      expect(out.whatsappWabaName).toBe('My WABA');
      expect(out.whatsappDisplayPhoneNumber).toBe('+15551234567');
    }
  });

  it('parses a valid Instagram list-item', () => {
    const out: Channel = parseChannelListItem(baseValidIg);
    expect(out.type).toBe('instagram');
    if (out.type === 'instagram') {
      expect(out.instagramUsername).toBe('ordvir');
    }
  });

  it('tolerates unknown extras on the wire (forward-compat)', () => {
    expect(() =>
      parseChannelListItem({ ...baseValidWa, newBackendField: 'whatever' }),
    ).not.toThrow();
  });

  it('throws UnexpectedError MALFORMED_CHANNEL when type is missing', () => {
    const { type: _t, ...broken } = baseValidWa;
    expect(() => parseChannelListItem(broken)).toThrow(UnexpectedError);
    expect(() => parseChannelListItem(broken)).toThrow(/MALFORMED_CHANNEL/);
  });

  it('throws when WA channel is missing required whatsappWabaName', () => {
    const { whatsappWabaName: _w, ...broken } = baseValidWa;
    expect(() => parseChannelListItem(broken)).toThrow(/whatsappWabaName/);
  });

  it('throws when type is "messenger" (forward-compat: union allows it)', () => {
    const messenger = {
      id: 'ch_MS000000',
      type: 'messenger',
      workspaceId: 'ws_aaaaaaa',
      metaWabaId: '',
      metaResourceId: '1234',
      connectionType: null,
      metaConnected: false,
      forwardingEnabled: false,
      webhookUrl: null,
      verifyToken: null,
    };
    expect(parseChannelListItem(messenger).type).toBe('messenger');
  });
});

describe('parseChannelListItem — Phase A backend cleanup shape', () => {
  it('When IG channel has metaWabaId=null, then parser accepts', () => {
    const dto = {
      id: 'ch_TEST0001',
      workspaceId: 'ws_TEST0001',
      metaWabaId: null, // Phase A change: was '', now null
      metaResourceId: '17841999999999999',
      connectionType: 'instagram_login',
      metaConnected: true,
      forwardingEnabled: true,
      webhookUrl: null,
      verifyToken: null,
      type: 'instagram',
      instagramUsername: 'test',
      instagramProfileName: 'Test',
      instagramProfilePictureUrl: null,
    };
    const parsed = parseChannelListItem(dto);
    expect(parsed.metaWabaId).toBeNull();
  });

  it('When WA channel omits whatsappVerifiedName + whatsappQualityRatingCheckedAt, then parser tolerates (older backends)', () => {
    const dto = {
      id: 'ch_TEST0002',
      workspaceId: 'ws_TEST0001',
      metaWabaId: '1248091060795230',
      metaResourceId: '1248091060795230',
      connectionType: 'coexistence',
      metaConnected: true,
      forwardingEnabled: true,
      webhookUrl: null,
      verifyToken: null,
      type: 'whatsapp',
      whatsappWabaName: 'tomer office',
      whatsappDisplayPhoneNumber: '+972 55-727-7945',
      whatsappPhoneNumberId: '979105081963262',
      whatsappQualityRating: 'GREEN',
      // whatsappVerifiedName: ABSENT (older backend that didn't emit it)
      // whatsappQualityRatingCheckedAt: ABSENT (Phase A drops it)
    };
    const parsed = parseChannelListItem(dto);
    expect(parsed.type).toBe('whatsapp');
    if (parsed.type === 'whatsapp') {
      // Absent on the wire normalizes to null on the parsed shape.
      expect(parsed.whatsappVerifiedName).toBeNull();
    }
  });

  it('When WA channel has whatsappVerifiedName distinct from whatsappWabaName, then parser preserves both', () => {
    const dto = {
      id: 'ch_TEST0004',
      workspaceId: 'ws_TEST0001',
      metaWabaId: '1248091060795230',
      metaResourceId: '1248091060795230',
      connectionType: 'coexistence',
      metaConnected: true,
      forwardingEnabled: true,
      webhookUrl: null,
      verifyToken: null,
      type: 'whatsapp',
      whatsappWabaName: 'Acme Holdings',
      whatsappVerifiedName: 'Acme Sales Team', // distinct from whatsappWabaName
      whatsappDisplayPhoneNumber: '+1 555-100-1000',
      whatsappPhoneNumberId: '979105081963262',
      whatsappQualityRating: 'GREEN',
    };
    const parsed = parseChannelListItem(dto);
    expect(parsed.type).toBe('whatsapp');
    if (parsed.type === 'whatsapp') {
      expect(parsed.whatsappWabaName).toBe('Acme Holdings');
      expect(parsed.whatsappVerifiedName).toBe('Acme Sales Team');
    }
  });

  it('When channel omits hostname/lastHeartbeatAt/hasActiveCliTunnel, then parsed object does not carry them', () => {
    const dto = {
      id: 'ch_TEST0003',
      workspaceId: 'ws_TEST0001',
      metaWabaId: null,
      metaResourceId: '17841888888888888',
      connectionType: 'instagram_login',
      metaConnected: true,
      forwardingEnabled: true,
      webhookUrl: null,
      verifyToken: null,
      type: 'instagram',
      instagramUsername: 'test',
      instagramProfileName: 'Test',
      instagramProfilePictureUrl: null,
      // hostname/lastHeartbeatAt/hasActiveCliTunnel: ABSENT (Phase A drops them)
    };
    const parsed = parseChannelListItem(dto);
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty('hostname');
    expect(parsed).not.toHaveProperty('lastHeartbeatAt');
    expect(parsed).not.toHaveProperty('hasActiveCliTunnel');
  });

  it('When channel includes credentialPublicId, then the parser surfaces it (gateway key path)', () => {
    const parsed = parseChannelListItem({ ...baseValidWa, credentialPublicId: 'cred_AAAA1111' });
    expect(parsed.credentialPublicId).toBe('cred_AAAA1111');
  });

  it('When channel omits credentialPublicId, then parsed.credentialPublicId is undefined', () => {
    const parsed = parseChannelListItem(baseValidWa);
    expect(parsed.credentialPublicId).toBeUndefined();
  });

  it('When channel includes updatedAt, then the parser carries it through (CLI re-auth signal)', () => {
    const dto = {
      id: 'ch_TEST0004',
      workspaceId: 'ws_TEST0001',
      metaWabaId: null,
      metaResourceId: '17841999999999999',
      connectionType: 'instagram_login',
      metaConnected: true,
      forwardingEnabled: true,
      webhookUrl: null,
      verifyToken: null,
      type: 'instagram',
      instagramUsername: 'test',
      instagramProfileName: 'Test',
      instagramProfilePictureUrl: null,
      updatedAt: '2026-05-28T08:00:00.000Z',
    };
    const parsed = parseChannelListItem(dto);
    expect(parsed.updatedAt).toBe('2026-05-28T08:00:00.000Z');
  });
});

describe('parseChannelDetail', () => {
  it('extends list-item with detail-only fields (accessToken, whatsappBusinessName, metaBusinessId)', () => {
    const detail: ChannelDetail = parseChannelDetail({
      ...baseValidWa,
      accessToken: 'EAAxxx...',
      whatsappBusinessName: 'Test Business',
      metaBusinessId: '100000000000000',
    });
    expect(detail.accessToken).toBe('EAAxxx...');
    expect(detail.whatsappBusinessName).toBe('Test Business');
    expect(detail.metaBusinessId).toBe('100000000000000');
  });

  it('list-item shape (without detail fields) parses with detail-only fields undefined', () => {
    const detail = parseChannelDetail(baseValidIg);
    expect(detail.accessToken).toBeUndefined();
    expect(detail.whatsappBusinessName).toBeUndefined();
  });
});
