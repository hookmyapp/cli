import { Command } from 'commander';

// Commander v14's `addHelpText('after', ...)` appends text only at `outputHelp()`
// time (via the `afterHelp` event). It does NOT extend `cmd.helpInformation()`,
// which returns a deterministic string from the built-in help formatter.
//
// The Wave-0 help.test.ts (frozen contract) asserts against
// `cmd.helpInformation()`, so we need a path that extends BOTH:
//   1. the real CLI `--help` output (addHelpText, via event)
//   2. the `helpInformation()` string (monkey-patched below)
//
// `addExamples(cmd, text)` does both in one call. The Prototype patch is
// installed on first call and is idempotent.

interface CommandWithHelpText extends Command {
  _afterHelpText?: string;
}

let helpInfoPatched = false;

function patchHelpInformation(): void {
  if (helpInfoPatched) return;
  helpInfoPatched = true;

  const originalHelpInformation = Command.prototype.helpInformation;
  Command.prototype.helpInformation = function (
    this: CommandWithHelpText,
    ...args: unknown[]
  ): string {
    const base = originalHelpInformation.apply(
      this,
      args as Parameters<typeof originalHelpInformation>,
    );
    const extra = this._afterHelpText;
    if (!extra) return base;
    // Mirror Commander's own outputHelp newline handling: the stored text
    // already begins with '\n', so append directly + trailing '\n' to match
    // the `${helpStr}\n` format from addHelpText's event emitter.
    return base + extra + '\n';
  };
}

/**
 * Attach an EXAMPLES (or other "after") help block to a Commander command.
 *
 * Unlike raw `cmd.addHelpText('after', text)`, this makes the text visible to
 * `cmd.helpInformation()` as well — which is what our test harness inspects.
 * Real `hookmyapp X --help` output uses Commander's `outputHelp()`, which in
 * turn calls the patched `helpInformation()`, so end users see the same
 * extended text. We do NOT also call `cmd.addHelpText()` — that would fire
 * `afterHelp` event AND re-emit via the writer, duplicating the block.
 *
 * Call as many times as needed; subsequent calls append.
 */
export function addExamples(cmd: Command, text: string): void {
  patchHelpInformation();
  const host = cmd as CommandWithHelpText;
  host._afterHelpText = (host._afterHelpText ?? '') + text;
}
