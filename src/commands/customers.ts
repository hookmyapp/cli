import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { addExamples } from '../output/help.js';
import type { Workspace } from '../types/workspace.js';
import { readWorkspaceConfig, switchActiveWorkspace } from './workspace.js';

/**
 * SaaS customers surface. A customer IS a workspace (`kind='customer'`) —
 * this group is a filtered view over the same `/workspaces` union plus the
 * org onboarding-link endpoints, reusing the workspace active-context
 * machinery. `customers new` is intentionally omitted: a customer is born
 * when its owner connects via an onboarding link.
 */
export function registerCustomersCommand(program: Command): void {
  const cust = program.command('customers').description('Manage SaaS customers (customer workspaces)');

  const custList = cust.command('list')
    .description('List customers')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const all = (await apiClient('/workspaces')) as Workspace[];
      const customers = all.filter((w) => w.kind === 'customer');
      if (opts.json || program.opts().json) {
        console.log(JSON.stringify(customers, null, 2));
        return;
      }
      const config = readWorkspaceConfig();
      const rows = customers.map((w) => ({
        ACTIVE: w.id === config.activeWorkspaceId ? '*' : ' ',
        NAME: w.name,
        SLUG: w.workosOrganizationId,
        ROLE: w.role,
      }));
      output(rows, { human: true });
    });

  const custUse = cust.command('use')
    .description('Switch the active workspace to a customer')
    .argument('[name-or-id]', 'Customer name or publicId (ws_XXXXXXXX). Omit for interactive picker.')
    .action(async (nameOrId?: string) => {
      const workspace = await switchActiveWorkspace(nameOrId, { kind: 'customer' });
      if (program.opts().json) {
        output({ id: workspace.id, name: workspace.name }, { human: false });
      } else {
        console.log(`Active customer: ${workspace.name} (${workspace.id})`);
      }
    });

  const custCurrent = cust.command('current')
    .description('Show the active workspace if it is a customer')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const all = (await apiClient('/workspaces')) as Workspace[];
      const active = readWorkspaceConfig().activeWorkspaceId;
      const cur = all.find((w) => w.id === active && w.kind === 'customer');
      const json = !!(opts.json || program.opts().json);
      if (!cur) {
        output(
          json
            ? { active: null, message: 'active workspace is not a customer' }
            : 'Active workspace is not a customer. Run: hookmyapp customers use',
          { json },
        );
        return;
      }
      output(
        json
          ? { id: cur.id, name: cur.name, role: cur.role }
          : `Name:  ${cur.name}\nID:    ${cur.id}\nRole:  ${cur.role}`,
        { json },
      );
    });

  addExamples(
    cust,
    `
EXAMPLES:
  $ hookmyapp customers list
  $ hookmyapp customers use "Acme Corp"
  $ hookmyapp customers current
`,
  );

  addExamples(
    custList,
    `
EXAMPLES:
  $ hookmyapp customers list
  $ hookmyapp customers list --json
`,
  );

  addExamples(
    custUse,
    `
EXAMPLES:
  $ hookmyapp customers use "Acme Corp"
  $ hookmyapp customers use ws_XXXXXXXX
`,
  );

  addExamples(
    custCurrent,
    `
EXAMPLES:
  $ hookmyapp customers current
  $ hookmyapp customers current --json
`,
  );
}
