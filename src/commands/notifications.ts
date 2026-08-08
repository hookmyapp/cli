import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { recordNoticesSnapshot } from '../notices-nudge.js';

/**
 * AIT-358 — `hookmyapp notifications`: the customer-facing notice feed
 * (problems HookMyApp detected, fixes applied, product announcements).
 * Thin wrapper over GET /notices + POST /notices/:id/ack; both subcommands
 * rewrite the local nudge cache from their real responses so the post-command
 * nudge (src/notices-nudge.ts) stays consistent immediately.
 */

const NOTICE_ID = /^ntc_[0-9A-Za-z]{8}$/;

interface Notice {
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

function assertNoticeId(id: string): void {
  if (!NOTICE_ID.test(id)) {
    throw new ValidationError(
      `Invalid notice id "${id}" — expected ntc_XXXXXXXX. Run: hookmyapp notifications list`,
    );
  }
}

export function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command('notifications')
    .description(
      'Notices from HookMyApp about problems with this integration (failing webhooks, ' +
        'disconnected channels, usage limits). Check after send failures; relay open ' +
        'notices to the human, then acknowledge.',
    );
  addExamples(
    notifications,
    `
EXAMPLES:
  $ hookmyapp notifications
  $ hookmyapp notifications ack ntc_A1b2C3d4
`,
  );

  const nList = notifications
    .command('list', { isDefault: true })
    .description('List open notices (newest first); --all includes acknowledged ones')
    .option('--all', 'Include acknowledged notices')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const res = (await apiClient(opts.all ? '/notices?all=true' : '/notices')) as {
        notices: Notice[];
      };
      const notices = res.notices;
      // Immediate consistency: the nudge cache mirrors what we just saw.
      await recordNoticesSnapshot(notices.filter((n) => !n.acknowledgedAt).length);
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(notices, null, 2));
        return;
      }
      if (notices.length === 0) {
        console.log('No open notices. All clear.');
        return;
      }
      output(
        notices.map((n) => ({
          ID: n.id,
          SEVERITY: n.severity,
          TITLE: n.title,
          CREATED: n.createdAt,
        })),
        { human: true },
      );
      // Agents relay the human-readable text, not just titles — print bodies.
      for (const n of notices) {
        console.log('');
        console.log(`${n.id} [${n.severity}] ${n.title}`);
        console.log(n.body);
        if (n.link) console.log(n.link);
      }
      console.log('');
      console.log('After relaying a notice, mark it seen: hookmyapp notifications ack <id>');
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
    .description('Mark a notice as seen after relaying it to the human (idempotent)')
    .argument('<id>', 'Notice id (ntc_…)')
    .option('--json', 'Output machine-readable JSON')
    .action(async (id: string, opts: { json?: boolean }) => {
      assertNoticeId(id);
      const res = (await apiClient(`/notices/${id}/ack`, { method: 'POST' })) as {
        notice: Notice;
      };
      // Rewrite the nudge cache from a fresh list, not a local decrement —
      // ack is idempotent, so re-acking an already-acked id (e.g. from
      // --all output) must not zero the cache while another notice is unread.
      // Best-effort: the ack itself already succeeded.
      try {
        const list = (await apiClient('/notices')) as { notices: Notice[] };
        await recordNoticesSnapshot(list.notices.filter((n) => !n.acknowledgedAt).length);
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
  $ hookmyapp notifications ack ntc_A1b2C3d4
  $ hookmyapp notifications ack ntc_A1b2C3d4 --json
`,
  );
}
