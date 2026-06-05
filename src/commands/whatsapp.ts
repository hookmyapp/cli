import type { Command } from 'commander';
import { addExamples } from '../output/help.js';

/** Registers the `whatsapp` (alias `wa`) command group. Subcommands are added by registerWhatsappMessages/Templates/Media/Profile (Plan 02). */
export function registerWhatsappCommand(program: Command): Command {
  const whatsapp = program
    .command('whatsapp')
    .alias('wa')
    .description('WhatsApp messaging, templates, media, and business profile');

  addExamples(
    whatsapp,
    `
EXAMPLES:
  $ hookmyapp whatsapp --help
  $ hookmyapp wa --help
`,
  );

  return whatsapp;
}
