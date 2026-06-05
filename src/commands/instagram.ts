import type { Command } from 'commander';

/** Registers the `instagram` (alias `ig`) command group. Subcommands added by Plan 03. */
export function registerInstagramCommand(program: Command): Command {
  return program
    .command('instagram')
    .alias('ig')
    .description('Instagram comments and direct messages');
}
