import { describe, it, expect } from 'vitest';
import { program } from '../index.js';

// Wave 0 RED: every command must ship an EXAMPLES section with ≥2 examples,
// and top-level --help must include USAGE + COMMON COMMANDS. Currently
// src/index.ts does not wire .addHelpText('after', ...) on any subcommand,
// so these assertions fail.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function walk(cmd: any, list: any[] = []): any[] {
  list.push(cmd);
  for (const sub of cmd.commands ?? []) walk(sub, list);
  return list;
}

describe('help text on every command — Wave 0 RED', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allCmds = walk(program).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c: any) => c.name() !== program.name(),
  );

  it.each(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    allCmds.map((c: any) => [c.name(), c]),
  )(
    '%s has EXAMPLES section with ≥2 examples',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_name: string, cmd: any) => {
      const help: string = cmd.helpInformation();
      expect(help).toContain('EXAMPLES:');
      const exampleLines = help
        .split('\n')
        .filter((l: string) => l.startsWith('  $ hookmyapp '));
      expect(exampleLines.length).toBeGreaterThanOrEqual(2);
    },
  );

  it('top-level help includes USAGE + COMMON COMMANDS', () => {
    const help = program.helpInformation();
    expect(help).toContain('USAGE');
    expect(help).toContain('COMMON COMMANDS');
  });

  it('login --help advertises wizard behavior', () => {
    const login = program.commands.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => c.name() === 'login',
    );
    expect(login).toBeDefined();
    const help = login!.helpInformation();
    expect(help.toLowerCase()).toMatch(/wizard|workspace picker/);
  });
});
