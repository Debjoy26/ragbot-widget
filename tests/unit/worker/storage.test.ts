import { describe, expect, it, vi } from 'vitest';
import {
  createStorage,
  isSafeObjectPath,
  KNOWLEDGE_BUCKET,
  normalizeEtag,
  StorageError,
} from '../../../worker/src/lib/storage.ts';

// P6-QUEUE: the worker's Storage client. The fetch is a labelled fake; no network.

const KEY = 'TEST-ONLY-opaque-secret-key-AAAA';
const URL_BASE = 'http://127.0.0.1:54321';
const BOT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const VER = '33333333-3333-4333-8333-333333333333';
const PATH = `${BOT}/${DOC}/${VER}/manual.pdf`;

function streamOf(parts: Uint8Array[], onPull?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      const next = parts[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
}

function setup(respond: (url: string, init: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(respond(String(input), init ?? {}));
  }) as unknown as typeof fetch;
  const storage = createStorage({ url: URL_BASE, secretKey: KEY, timeoutMs: 5000, fetchImpl });
  return { storage, requests };
}

async function failure(p: Promise<unknown>): Promise<StorageError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    return err as StorageError;
  }
  throw new Error('expected a failure');
}

describe('createStorage: configuration (fail closed)', () => {
  it.each([
    { url: URL_BASE, secretKey: '', timeoutMs: 1000 },
    { url: URL_BASE, secretKey: KEY, timeoutMs: 0 },
    { url: 'nope', secretKey: KEY, timeoutMs: 1000 },
    { url: 'http://example.com', secretKey: KEY, timeoutMs: 1000 },
    { url: 'https://u:p@example.com', secretKey: KEY, timeoutMs: 1000 },
  ])('throws for a bad option set', (options) => {
    expect(() => createStorage(options)).toThrow(TypeError);
  });
});

describe('object path safety', () => {
  it('accepts the storage_path shape', () => {
    expect(isSafeObjectPath(PATH)).toBe(true);
    expect(isSafeObjectPath(`${BOT}/${DOC}/${VER}/my file (1).md`)).toBe(true);
  });

  it.each([
    '',
    'manual.pdf',
    `${BOT}/${DOC}/manual.pdf`,
    `../${BOT}/${DOC}/${VER}/x.pdf`,
    `${BOT}/${DOC}/${VER}/../x.pdf`,
    `${BOT}/${DOC}/${VER}/..`,
    `${BOT}/${DOC}/${VER}/.`,
    `${BOT}/${DOC}/${VER}/a/b.pdf`,
    `${BOT}/${DOC}/${VER}/a\u0000b.pdf`,
    `${BOT}/${DOC}/${VER}/a\nb.pdf`,
    `AAAAAAAA-1111-4111-8111-111111111111/${DOC}/${VER}/x.pdf`,
    `/${BOT}/${DOC}/${VER}/x.pdf`,
    `${BOT}/${DOC}/${VER}/${'a'.repeat(256)}`,
    `other-bucket/${PATH}`,
  ])('rejects %j', (p) => {
    expect(isSafeObjectPath(p)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSafeObjectPath(undefined)).toBe(false);
    expect(isSafeObjectPath(42)).toBe(false);
  });

  it('download and remove refuse an unsafe path before any request', async () => {
    const { storage, requests } = setup(() => new Response('x'));
    await expect(storage.download('../etc/passwd', 100)).rejects.toThrow(TypeError);
    await expect(storage.remove([PATH, 'bad/path'])).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it('percent-encodes each segment of the request path', async () => {
    const odd = `${BOT}/${DOC}/${VER}/a b#c?d%e.md`;
    const { storage, requests } = setup(() => new Response('x'));
    await storage.download(odd, 100);
    expect(requests[0]?.url).toBe(
      `${URL_BASE}/storage/v1/object/authenticated/${KNOWLEDGE_BUCKET}/${BOT}/${DOC}/${VER}/a%20b%23c%3Fd%25e.md`,
    );
  });
});

describe('Storage.download', () => {
  it('returns bytes, eTag and content type; sends the key and refuses redirects', async () => {
    const { storage, requests } = setup(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { etag: '"abc123"', 'content-type': 'application/pdf' },
        }),
    );
    const out = await storage.download(PATH, 10);
    expect([...out.bytes]).toEqual([1, 2, 3]);
    expect(out.etag).toBe('"abc123"');
    expect(out.contentType).toBe('application/pdf');
    expect(requests[0]?.init.redirect).toBe('error');
    expect((requests[0]?.init.headers as Record<string, string>)['apikey']).toBe(KEY);
  });

  it('returns a null eTag when the header is missing', async () => {
    const { storage } = setup(() => new Response('x'));
    expect((await storage.download(PATH, 10)).etag).toBeNull();
  });

  it('accepts an object of exactly maxBytes', async () => {
    const { storage } = setup(() => new Response(new Uint8Array(10)));
    expect((await storage.download(PATH, 10)).bytes.byteLength).toBe(10);
  });

  it('refuses from content-length without reading the body', async () => {
    let pulled = 0;
    const { storage } = setup(
      () =>
        new Response(
          streamOf([new Uint8Array(5)], () => {
            pulled += 1;
          }),
          { headers: { 'content-length': '1000' } },
        ),
    );
    const err = await failure(storage.download(PATH, 100));
    expect(err.reason).toBe('too_large');
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('stops a stream that lies about its size at the cap and cancels it', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(40));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { storage } = setup(() => new Response(body));
    const err = await failure(storage.download(PATH, 100));
    expect(err.reason).toBe('too_large');
    expect(cancelled).toBe(true);
    // 40 + 40 + 40 crosses 100 on the third chunk; an unbounded read would never end.
    expect(pulled).toBeLessThanOrEqual(5);
  });

  it('reports a missing object as http 404 and an error body is not copied', async () => {
    const { storage } = setup(
      () => new Response(JSON.stringify({ message: `secret ${KEY}` }), { status: 404 }),
    );
    const err = await failure(storage.download(PATH, 100));
    expect(err.reason).toBe('http');
    expect(err.status).toBe(404);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain(PATH);
  });

  it('reports network failure and caller abort', async () => {
    const down = createStorage({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 1000,
      fetchImpl: (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch,
    });
    expect((await failure(down.download(PATH, 10))).reason).toBe('network');
  });

  it('reports a timeout', async () => {
    const hang = createStorage({
      url: URL_BASE,
      secretKey: KEY,
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            rej(new DOMException('aborted', 'AbortError'));
          });
        })) as unknown as typeof fetch,
    });
    expect((await failure(hang.download(PATH, 10))).reason).toBe('timeout');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxBytes %s', async (n) => {
    const { storage } = setup(() => new Response('x'));
    await expect(storage.download(PATH, n)).rejects.toThrow(TypeError);
  });
});

describe('Storage.remove', () => {
  it('DELETEs the bucket with the paths as prefixes', async () => {
    const { storage, requests } = setup(() => new Response('[]'));
    expect(await storage.remove([PATH])).toBe(1);
    expect(requests[0]?.url).toBe(`${URL_BASE}/storage/v1/object/${KNOWLEDGE_BUCKET}`);
    expect(requests[0]?.init.method).toBe('DELETE');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ prefixes: [PATH] });
  });

  it('does nothing for an empty list and batches large lists', async () => {
    const { storage, requests } = setup(() => new Response('[]'));
    expect(await storage.remove([])).toBe(0);
    expect(requests).toHaveLength(0);
    const many = Array.from({ length: 250 }, (_, i) => `${BOT}/${DOC}/${VER}/f${String(i)}.md`);
    await storage.remove(many);
    expect(requests).toHaveLength(3);
    expect(JSON.parse(String(requests[2]?.init.body)).prefixes).toHaveLength(50);
  });

  it('fails with the status on an error response', async () => {
    const { storage } = setup(() => new Response('{}', { status: 500 }));
    const err = await failure(storage.remove([PATH]));
    expect(err.status).toBe(500);
  });
});

describe('normalizeEtag', () => {
  it.each([
    ['"abc"', 'abc'],
    ['W/"abc"', 'abc'],
    ['abc', 'abc'],
    ['  "abc" ', 'abc'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeEtag(input)).toBe(expected);
  });
});
