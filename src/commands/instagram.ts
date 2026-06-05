import type { Command } from 'commander';
import { addExamples } from '../output/help.js';

/** Registers the `instagram` (alias `ig`) command group. Subcommands added by Plan 03. */
export function registerInstagramCommand(program: Command): Command {
  const instagram = program
    .command('instagram')
    .alias('ig')
    .description('Instagram comments and direct messages');

  addExamples(
    instagram,
    `
EXAMPLES:
  $ hookmyapp instagram --help
  $ hookmyapp ig --help
`,
  );

  return instagram;
}
