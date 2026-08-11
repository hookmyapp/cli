import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { recordNotificationsSnapshot } from '../notifications-nudge.js';

/**
 * AIT-358 — `hookmyapp notifications`: the customer-facing notification feed
 * (problems HookMyApp detected, fixes applied, product announcements).
 * Thin wrapper over GET /notifications + POST /notifications/:id/ack; both subcommands
 * rewrite the local nudge cache from their real responses so the post-command
 * nudge (src/notifications-nudge.ts) stays consistent immediately.
 */

const NOTICE_ID = /^ntf_[0-9A-Za-z]{8}$/;

interface Notification {
  id: string;
  severity: string;
  scope: 'organization' | 'workspace' | 'channel';
  workspaceId?: string;
  channelId?: string;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  acknowledgedAt?: string;
}

function assertNotificationId(id: string): void {
  if (!NOTICE_ID.test(id)) {
    throw new ValidationError(
      `Invalid notification id "${id}" — expected ntf_XXXXXXXX. Run: hookmyapp notifications list`,
    );
  }
}

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command('notifications')
    .description(
      'Notifications from HookMyApp about problems with this integration (failing webhooks, ' +
        'disconnected channels, usage limits). Check after send failures; relay open ' +
        'notifications to the human, then acknowledge.',
    );
  addExamples(
    notifications,
    `
EXAMPLES:
  $ hookmyapp notifications
  $ hookmyapp notifications ack ntf_A1b2C3d4
`,
  );

  const nList = notifications
    .command('list', { isDefault: true })
    .description('List open notifications (newest first); --all includes acknowledged ones')
    .option('--all', 'Include acknowledged notifications')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const res = (await apiClient(opts.all ? '/notifications?all=true' : '/notifications')) as {
        notifications: Notification[];
      };
      const notifications = res.notifications;
      // Immediate consistency: the nudge cache mirrors what we just saw.
      await recordNotificationsSnapshot(notifications.filter((n) => !n.acknowledgedAt).length);
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(notifications, null, 2));
        return;
      }
      if (notifications.length === 0) {
        console.log('No open notifications. All clear.');
        return;
      }
      output(
        notifications.map((n) => ({
          ID: n.id,
          SEVERITY: n.severity,
          TITLE: n.title,
          CREATED: n.createdAt,
        })),
        { human: true },
      );
      // Agents relay the human-readable text, not just titles — print bodies.
      for (const n of notifications) {
        console.log('');
        console.log(`${n.id} [${n.severity}] ${n.title}`);
        console.log(n.body);
        if (n.link) console.log(n.link);
      }
      console.log('');
      console.log('After relaying a notification, mark it seen: hookmyapp notifications ack <id>');
    });
  addExamples(
    nList,
    `
EXAMPLES:
  $ hookmyapp notifications list
  $ hookmyapp notifications list --all --json
`,
  );

  const nAck = notifications
    .command('ack')
    .description('Mark a notification as seen after relaying it to the human (idempotent)')
    .argument('<id>', 'Notification id (ntf_…)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      assertNotificationId(id);
      const res = (await apiClient(`/notifications/${id}/ack`, { method: 'POST' })) as {
        notification: Notification;
      };
      // Rewrite the nudge cache from a fresh list, not a local decrement —
      // ack is idempotent, so re-acking an already-acked id (e.g. from
      // --all output) must not zero the cache while another notification is unread.
      // Best-effort: the ack itself already succeeded.
      try {
        const list = (await apiClient('/notifications')) as { notifications: Notification[] };
        await recordNotificationsSnapshot(list.notifications.filter((n) => !n.acknowledgedAt).length);
      } catch {
        // stale cache self-heals on the next background refresh or list
      }
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      console.log(`Acknowledged ${id}.`);
    });
  addExamples(
    nAck,
    `
EXAMPLES:
  $ hookmyapp notifications ack ntf_A1b2C3d4
  $ hookmyapp notifications ack ntf_A1b2C3d4 --json
`,
  );
}
