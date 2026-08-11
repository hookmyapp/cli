import type { Command } from 'commander';
import { apiClient } from '../api/client.js';
import { output } from '../output/format.js';
import { ValidationError } from '../output/error.js';
import { addExamples } from '../output/help.js';
import { getDefaultWorkspaceId, resolveOrgPublicIdForWorkspace } from './_helpers.js';

/**
 * AIT-370 — `hookmyapp org profile`: read/write the organization profile
 * (company info). This is COMPANY data — the `--phone` here is the company
 * phone, NOT anyone's personal alert phone (that is `hookmyapp alerts phone`).
 * Ask the human for company details; never infer or invent them. Org admins only.
 */

interface OrgProfile {
  publicId: string;
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  businessCategory: string | null;
  businessNiche: string | null;
  primaryUseCase: string | null;
}

function printProfile(profile: OrgProfile, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(profile, null, 2));
    return;
  }
  output(
    [
      {
        ORG: profile.publicId,
        NAME: profile.name,
        EMAIL: profile.email ?? '',
        PHONE: profile.phone ?? '',
        WEBSITE: profile.website ?? '',
        CATEGORY: profile.businessCategory ?? '',
        NICHE: profile.businessNiche ?? '',
        'USE CASE': profile.primaryUseCase ?? '',
      },
    ],
    { human: true },
  );
}

export function registerOrgProfileCommand(program: Command): void {
  // `org` may already exist (other org-scoped commands); reuse it if so.
  const existing = program.commands.find((c) => c.name() === 'org');
  const org = existing ?? program.command('org').description('Organization-level settings');
  if (!existing) {
    addExamples(
      org,
      `
EXAMPLES:
  $ hookmyapp org profile
  $ hookmyapp org profile set --website https://acme.com
`,
    );
  }

  const profile = org
    .command('profile')
    .description(
      'Company profile (email, phone, website, business category/niche, use case). ' +
        'Company data — for your personal alert number use: hookmyapp alerts phone',
    );
  addExamples(
    profile,
    `
EXAMPLES:
  $ hookmyapp org profile
  $ hookmyapp org profile set --website https://acme.com --business-category "E-commerce"
`,
  );

  const show = profile
    .command('show', { isDefault: true })
    .description('Show the organization profile')
    .option('--json', 'Output machine-readable JSON')
    .action(async (opts: { json?: boolean }) => {
      const workspaceId = await getDefaultWorkspaceId();
      const orgPublicId = await resolveOrgPublicIdForWorkspace(workspaceId);
      const res = (await apiClient(`/organizations/${orgPublicId}`)) as { organization?: OrgProfile } & OrgProfile;
      const data = (res.organization ?? res) as OrgProfile;
      printProfile(data, Boolean(opts.json || program.opts().json));
    });
  addExamples(show, `\nEXAMPLES:\n  $ hookmyapp org profile show\n  $ hookmyapp org profile show --json\n`);

  const set = profile
    .command('set')
    .description('Update company profile fields (only provided flags change; "" clears a field)')
    .option('--email <email>', 'Company contact email')
    .option('--phone <phone>', 'Company phone (NOT your personal alert phone)')
    .option('--website <url>', 'Company website')
    .option('--business-category <text>', 'e.g. E-commerce, SaaS, Agency')
    .option('--business-niche <text>', 'e.g. Fashion retail, Dental clinics')
    .option('--primary-use-case <text>', 'What the company uses HookMyApp for')
    .option('--json', 'Output machine-readable JSON')
    .action(
      async (opts: {
        email?: string;
        phone?: string;
        website?: string;
        businessCategory?: string;
        businessNiche?: string;
        primaryUseCase?: string;
        json?: boolean;
      }) => {
        const body: Record<string, string> = {};
        for (const key of ['email', 'phone', 'website', 'businessCategory', 'businessNiche', 'primaryUseCase'] as const) {
          if (opts[key] !== undefined) body[key] = opts[key] as string;
        }
        if (Object.keys(body).length === 0) {
          throw new ValidationError(
            'Nothing to update — pass at least one of --email/--phone/--website/--business-category/--business-niche/--primary-use-case',
          );
        }
        const workspaceId = await getDefaultWorkspaceId();
        const orgPublicId = await resolveOrgPublicIdForWorkspace(workspaceId);
        const res = (await apiClient(`/organizations/${orgPublicId}/profile`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })) as OrgProfile;
        printProfile(res, Boolean(opts.json || program.opts().json));
      },
    );
  addExamples(set, `\nEXAMPLES:\n  $ hookmyapp org profile set --email hello@acme.com\n  $ hookmyapp org profile set --business-niche "Dental clinics" --primary-use-case "Appointment reminders"\n`);
}
