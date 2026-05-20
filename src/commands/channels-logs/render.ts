import type { DeliveryListItem } from './api.js';

/**
 * Compact "time ago" label for the list table's `Received` column.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const sec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Project delivery list items into flat rows for `renderTable`. `Status` is the
 * server-rendered `humanStatus`; the longer `humanStatusCopy` surfaces only in
 * `show` detail (spec D8).
 */
export function toListRows(
  deliveries: DeliveryListItem[],
  now: Date = new Date(),
): Record<string, unknown>[] {
  return deliveries.map((d) => ({
    ID: d.id,
    Received: relativeTime(d.receivedAt, now),
    Status: d.humanStatus,
    From: d.fromPhone ?? '-',
    Forwarded: d.latestAttempt?.forwardStatus ?? '-',
    Attempts: d.attemptsCount,
  }));
}
