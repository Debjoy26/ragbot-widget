import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildPdf } from './fixtures/pdf.ts';

// P6-D2-W: the PDF child runs under Node's permission model. These tests run a REAL Node process
// with the exact flags the extractor uses (confinementArgs) and a probe script passed with -e.

const spawnMock = vi.hoisted(() => ({ fail: null as NodeJS.ErrnoException | null }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      if (spawnMock.fail === null) return actual.spawn(...args);
      // A labelled FAKE child that fails to start.
      const fake = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        killed: boolean;
        kill(): boolean;
      };
      fake.stdin = new PassThrough();
      fake.stdout = new PassThrough();
      fake.stderr = new PassThrough();
      fake.killed = false;
      fake.kill = () => true;
      const err = spawnMock.fail;
      setImmediate(() => fake.emit('error', err));
      return fake as unknown as ReturnType<typeof actual.spawn>;
    }) as typeof actual.spawn,
  };
});

const { confinementArgs, ExtractError, ExtractSpawnError, extractText } =
  await import('../../../worker/src/lib/extract.ts');

const LIMITS = { timeoutMs: 30_000, maxMemoryMb: 512, maxPages: 10, maxChars: 1_000_000 };
const CHILD = new URL('../../../worker/src/lib/extract-child.ts', import.meta.url).pathname;
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

const dir = mkdtempSync(join(tmpdir(), 'ragbot-confine-'));
const OUTSIDE = join(dir, 'outside.txt');
const SENTINEL = `outside-content-${String(Math.random()).slice(2)}`;
writeFileSync(OUTSIDE, SENTINEL);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PROBE = `
const fs = require('node:fs');
const [outside, environ, allowedScript, allowedPkg] = process.argv.slice(1);
const attempt = (fn) => { try { fn(); return 'READ'; } catch (e) { return e.code ?? 'ERR'; } };
const result = {
  outside: attempt(() => fs.readFileSync(outside)),
  environ: attempt(() => fs.readFileSync(environ)),
  selfEnviron: attempt(() => fs.readFileSync('/proc/self/environ')),
  script: attempt(() => fs.readFileSync(allowedScript)),
  pkg: attempt(() => fs.readFileSync(allowedPkg)),
  write: attempt(() => fs.writeFileSync(outside, 'x')),
  spawn: attempt(() => require('node:child_process').spawnSync('true')),
  codegen: attempt(() => new Function('return 1')()),
};
process.stdout.write(JSON.stringify(result));
`;

function probe(confined: boolean): Record<string, string> {
  const flags = confined ? confinementArgs(256, CHILD) : [];
  const run = spawnSync(
    process.execPath,
    [
      ...flags,
      '-e',
      PROBE,
      OUTSIDE,
      `/proc/${String(process.pid)}/environ`,
      CHILD,
      join(PDFJS_DIR, 'package.json'),
    ],
    { env: {}, encoding: 'utf8' },
  );
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as Record<string, string>;
}

describe('PDF child confinement (real node process, the flags the extractor uses)', () => {
  it('control: an unconfined node can read the file and the parent environment', () => {
    const open = probe(false);
    expect(open['outside']).toBe('READ');
    expect(open['environ']).toBe('READ');
    expect(open['codegen']).toBe('READ');
  });

  it('cannot read a temporary file outside the allowed paths, nor the parent environ', () => {
    const closed = probe(true);
    expect(closed['outside']).toBe('ERR_ACCESS_DENIED');
    expect(closed['environ']).toBe('ERR_ACCESS_DENIED');
    expect(closed['selfEnviron']).toBe('ERR_ACCESS_DENIED');
  });

  it('can read exactly its script and the pdfjs package directory', () => {
    const closed = probe(true);
    expect(closed['script']).toBe('READ');
    expect(closed['pkg']).toBe('READ');
  });

  it('cannot write files, start processes or compile code from strings', () => {
    const closed = probe(true);
    expect(closed['write']).toBe('ERR_ACCESS_DENIED');
    expect(closed['spawn']).toBe('ERR_ACCESS_DENIED');
    expect(closed['codegen']).not.toBe('READ');
  });

  it('allows only the child script and the pdfjs package directory to be read', () => {
    const args = confinementArgs(256, CHILD);
    expect(args).toContain('--permission');
    expect(args).toContain('--disallow-code-generation-from-strings');
    expect(args).toContain('--max-old-space-size=256');
    const reads = args.filter((a) => a.startsWith('--allow-fs-read='));
    expect(reads).toEqual([`--allow-fs-read=${CHILD}`, `--allow-fs-read=${PDFJS_DIR}`]);
    expect(args.some((a) => a.startsWith('--allow-fs-write'))).toBe(false);
    expect(args.some((a) => a.startsWith('--allow-child-process'))).toBe(false);
    expect(args.some((a) => a.includes('*'))).toBe(false);
  });

  it('the real extraction still works under the confinement', async () => {
    const pdf = buildPdf({ pages: [['Confined child still extracts this sentence.']] });
    const result = await extractText(pdf, 'application/pdf', LIMITS);
    expect(result.pages[0]?.text).toContain('Confined child');
  });
});

describe('PDF child start failures are transient, not file failures', () => {
  it.each(['ENOENT', 'EACCES', 'EAGAIN'])(
    '%s throws ExtractSpawnError, not ExtractError',
    async (code) => {
      spawnMock.fail = Object.assign(new Error('spawn failed'), { code });
      try {
        const err = await extractText(
          buildPdf({ pages: [['Some text on a page here.']] }),
          'application/pdf',
          LIMITS,
        ).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ExtractSpawnError);
        expect(err).not.toBeInstanceOf(ExtractError);
        expect((err as InstanceType<typeof ExtractSpawnError>).code).toBe(code);
      } finally {
        spawnMock.fail = null;
      }
    },
  );

  it('a time kill and a memory kill stay FILE_UNSUPPORTED', async () => {
    const pdf = buildPdf({ pages: [['Some text on a page here.']] });
    const timeout = await extractText(pdf, 'application/pdf', { ...LIMITS, timeoutMs: 1 }).catch(
      (e: unknown) => e,
    );
    expect(timeout).toMatchObject({ code: 'FILE_UNSUPPORTED', reason: 'timeout' });
    const memory = await extractText(pdf, 'application/pdf', { ...LIMITS, maxMemoryMb: 1 }).catch(
      (e: unknown) => e,
    );
    expect(memory).toMatchObject({ code: 'FILE_UNSUPPORTED', reason: 'memory' });
  });
});
