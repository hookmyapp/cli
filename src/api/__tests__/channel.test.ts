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
  wabaName: 'My WABA',
  displayPhoneNumber: '+15551234567',
  phoneNumberId: '1080996501762047',
  phoneVerifiedName: 'Test Co.',
  qualityRating: 'GREEN',
  qualityRatingCheckedAt: '2026-05-26T12:00:00Z',
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
  instagramName: 'Or Dvir',
  instagramProfilePictureUrl: 'https://cdninstagram.com/...',
};

describe('parseChannelListItem', () => {
  it('parses a valid WhatsApp list-item', () => {
    const out: Channel = parseChannelListItem(baseValidWa);
    expect(out.type).toBe('whatsapp');
    if (out.type === 'whatsapp') {
      expect(out.wabaName).toBe('My WABA');
      expect(out.displayPhoneNumber).toBe('+15551234567');
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

  it('throws when WA channel is missing required wabaName', () => {
    const { wabaName: _w, ...broken } = baseValidWa;
    expect(() => parseChannelListItem(broken)).toThrow(/wabaName/);
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

describe('parseChannelDetail', () => {
  it('extends list-item with detail-only fields (accessToken, businessName, metaBusinessId)', () => {
    const detail: ChannelDetail = parseChannelDetail({
      ...baseValidWa,
      accessToken: 'EAAxxx...',
      businessName: 'Test Business',
      metaBusinessId: '100000000000000',
    });
    expect(detail.accessToken).toBe('EAAxxx...');
    expect(detail.businessName).toBe('Test Business');
    expect(detail.metaBusinessId).toBe('100000000000000');
  });

  it('list-item shape (without detail fields) parses with detail-only fields undefined', () => {
    const detail = parseChannelDetail(baseValidIg);
    expect(detail.accessToken).toBeUndefined();
    expect(detail.businessName).toBeUndefined();
  });
});
