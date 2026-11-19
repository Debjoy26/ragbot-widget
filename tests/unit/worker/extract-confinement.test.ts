import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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
// fileURLToPath, not URL.pathname: on Windows a pathname keeps a leading slash
// (`/D:/...`) that Node's fs cannot open (ENOENT) while the allow-list matches
// the string, hiding the confinement under test. Production uses fileURLToPath.
const CHILD = fileURLToPath(new URL('../../../worker/src/lib/extract-child.ts', import.meta.url));
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

// /proc does not exist on Windows, so the parent-environ probe targets the
// node binary itself there instead: it exists on every dev box and is never in
// the allow-list, so the unconfined/confined expectations hold on both
// platforms without weakening either side.
const ENVIRON =
  process.platform === 'win32' ? process.execPath : `/proc/${String(process.pid)}/environ`;
const SELF_ENVIRON = process.platform === 'win32' ? process.execPath : '/proc/self/environ';

const dir = mkdtempSync(join(tmpdir(), 'ragbot-confine-'));
const OUTSIDE = join(dir, 'outside.txt');
const SENTINEL = `outside-content-${String(Math.random()).slice(2)}`;
writeFileSync(OUTSIDE, SENTINEL);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PROBE = `
const fs = require('node:fs');
const [outside, environ, selfEnviron, allowedScript, allowedPkg] = process.argv.slice(1);
const attempt = (fn) => { try { fn(); return 'READ'; } catch (e) { return e.code ?? e.name ?? 'ERR'; } };
const result = {
  outside: attempt(() => fs.readFileSync(outside)),
  environ: attempt(() => fs.readFileSync(environ)),
  selfEnviron: attempt(() => fs.readFileSync(selfEnviron)),
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
    [...flags, '-e', PROBE, OUTSIDE, ENVIRON, SELF_ENVIRON, CHILD, join(PDFJS_DIR, 'package.json')],
    { env: {}, encoding: 'utf8' },
  );
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as Record<string, string>;
}

/** What reading each path does under the given node flags: 'READ' or the error code. */
function readCodes(flags: readonly string[], paths: readonly string[]): Record<string, string> {
  const script = `
const fs = require('node:fs');
const out = {};
for (const p of process.argv.slice(1)) {
  try { fs.readFileSync(p); out[p] = 'READ'; } catch (e) {
    if (e.code === 'EISDIR') { out[p] = 'READ'; continue; }
    out[p] = e.code ?? e.name ?? 'ERR';
  }
}
process.stdout.write(JSON.stringify(out));
`;
  const run = spawnSync(process.execPath, [...flags, '-e', script, ...paths], {
    env: {},
    encoding: 'utf8',
  });
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
    // The specific refusal, not just "not READ": --disallow-code-generation-from-strings raises an
    // EvalError (a permission error would also be a refusal, but a syntax or other error is not).
    expect(['EvalError', 'ERR_ACCESS_DENIED']).toContain(closed['codegen']);
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

  it('does not let the pdfjs directory flag reach a sibling whose name starts the same way', () => {
    // The real flags, a path that does not exist: a permission refusal comes before the file
    // system is asked, so ERR_ACCESS_DENIED means "not allowed" and ENOENT would mean "allowed".
    const siblings = [`${PDFJS_DIR}-other`, `${PDFJS_DIR}-other/package.json`, `${PDFJS_DIR}x`];
    const parent = dirname(PDFJS_DIR);
    const codes = readCodes(confinementArgs(256, CHILD), [
      ...siblings,
      join(parent, 'pdfjs-dist-other', 'package.json'),
      join(PDFJS_DIR, 'package.json'),
      parent,
    ]);
    for (const sibling of siblings) expect(codes[sibling], sibling).toBe('ERR_ACCESS_DENIED');
    expect(codes[join(parent, 'pdfjs-dist-other', 'package.json')]).toBe('ERR_ACCESS_DENIED');
    expect(codes[parent]).toBe('ERR_ACCESS_DENIED');
    expect(codes[join(PDFJS_DIR, 'package.json')]).toBe('READ'); // control: the flag does allow its own directory
  });

  it('keeps a real sibling directory with a shared name prefix unreadable (flag shape of confinementArgs)', () => {
    const allowed = join(dir, 'pdfjs-dist');
    const sibling = join(dir, 'pdfjs-dist-other');
    mkdirSync(allowed);
    mkdirSync(sibling);
    writeFileSync(join(allowed, 'a.txt'), 'allowed');
    writeFileSync(join(sibling, 'a.txt'), 'sibling');
    // Same flags as the extractor, with the pdfjs directory swapped for the fixture directory.
    const flags = confinementArgs(256, CHILD).map((a) =>
      a === `--allow-fs-read=${PDFJS_DIR}` ? `--allow-fs-read=${allowed}` : a,
    );
    expect(flags).toContain(`--allow-fs-read=${allowed}`);
    const codes = readCodes(flags, [join(allowed, 'a.txt'), join(sibling, 'a.txt'), sibling]);
    expect(codes[join(allowed, 'a.txt')]).toBe('READ');
    expect(codes[join(sibling, 'a.txt')]).toBe('ERR_ACCESS_DENIED');
    expect(codes[sibling]).toBe('ERR_ACCESS_DENIED');
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
