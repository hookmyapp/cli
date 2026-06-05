import type { Command } from 'commander';

/** Registers the `whatsapp` (alias `wa`) command group. Subcommands are added by registerWhatsappMessages/Templates/Media/Profile (Plan 02). */
export function registerWhatsappCommand(program: Command): Command {
  return program
    .command('whatsapp')
    .alias('wa')
    .description('WhatsApp messaging, templates, media, and business profile');
}
