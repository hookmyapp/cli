import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readBodyFlag, assertBodyXorFlags } from '../_body.js';
import { ValidationError } from '../../output/error.js';

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
let tmpDir: string | null = null;

afterEach(() => {
  if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('readBodyFlag', () => {
  test('inline JSON is parsed', async () => {
    await expect(readBodyFlag('{"to":"123","text":"hi"}')).resolves.toEqual({
      to: '123',
      text: 'hi',
    });
  });

  test('@file reads and parses the file contents', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hma-body-'));
    const file = join(tmpDir, 'body.json');
    writeFileSync(file, '{"from":"file"}');

    await expect(readBodyFlag(`@${file}`)).resolves.toEqual({ from: 'file' });
  });

  test("'-' reads JSON from stdin to EOF", async () => {
    Object.defineProperty(process, 'stdin', {
      value: Readable.from(['{"via":', '"stdin"}']),
      configurable: true,
    });

    await expect(readBodyFlag('-')).resolves.toEqual({ via: 'stdin' });
  });

  test('invalid JSON → ValidationError BAD_BODY_JSON', async () => {
    const err = await readBodyFlag('{nope').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('BAD_BODY_JSON');
  });
});

describe('assertBodyXorFlags', () => {
  test('both builder flags and --body → BODY_AND_FLAGS', () => {
    try {
      assertBodyXorFlags(true, true);
      expect.fail('expected ValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe('BODY_AND_FLAGS');
    }
  });

  test('neither builder flags nor --body → NO_PAYLOAD', () => {
    try {
      assertBodyXorFlags(false, false);
      expect.fail('expected ValidationError');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).code).toBe('NO_PAYLOAD');
    }
  });

  test('exactly one of the two → no throw', () => {
    expect(() => assertBodyXorFlags(true, false)).not.toThrow();
    expect(() => assertBodyXorFlags(false, true)).not.toThrow();
  });
});
