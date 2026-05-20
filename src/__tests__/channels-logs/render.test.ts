import { describe, it, expect } from 'vitest';
import { relativeTime, toListRows } from '../../commands/channels-logs/render.js';
import type { DeliveryListItem } from '../../commands/channels-logs/api.js';

const NOW = new Date('2026-05-20T12:00:00.000Z');

function item(over: Partial<DeliveryListItem>): DeliveryListItem {
  return {
    id: 'd1',
    receivedAt: '2026-05-20T11:58:00.000Z',
    fromPhone: '+14155550100',
    routingDecision: 'forwarded',
    attemptsCount: 1,
    humanStatus: 'Delivered',
    humanStatusCopy: 'Delivered to your app',
    humanStatusColor: 'green',
    latestAttempt: { outcome: 'delivered', forwardStatus: 200, attemptedAt: '2026-05-20T11:58:01.000Z' },
    ...over,
  };
}

describe('relativeTime', () => {
  it('renders sub-minute deltas as "just now"', () => {
    expect(relativeTime('2026-05-20T11:59:30.000Z', NOW)).toBe('just now');
  });

  it('renders minute, hour and day buckets', () => {
    expect(relativeTime('2026-05-20T11:45:00.000Z', NOW)).toBe('15m ago');
    expect(relativeTime('2026-05-20T09:00:00.000Z', NOW)).toBe('3h ago');
    expect(relativeTime('2026-05-18T12:00:00.000Z', NOW)).toBe('2d ago');
  });
});

describe('toListRows', () => {
  it('projects delivery items into flat table rows', () => {
    const rows = toListRows([item({ id: 'abc' })], NOW);
    expect(rows[0]).toEqual({
      ID: 'abc',
      Received: '2m ago',
      Status: 'Delivered',
      From: '+14155550100',
      Forwarded: 200,
      Attempts: 1,
    });
  });

  it('falls back to a dash for a missing phone or forward status', () => {
    const rows = toListRows(
      [item({ fromPhone: null, latestAttempt: null, attemptsCount: 0 })],
      NOW,
    );
    expect(rows[0].From).toBe('-');
    expect(rows[0].Forwarded).toBe('-');
  });
});
