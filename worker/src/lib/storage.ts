// Server-only Supabase Storage client for the worker's service (secret) key (P6-QUEUE).
//
// Design rules (handover.md section 4, TECH_SPECS section 8):
//  * The key is held in a closure. It is in no property of the returned object and no error.
//  * Object paths are checked against the exact storage_path shape the database enforces
//    ({bot uuid}/{document uuid}/{version uuid}/{filename}, migration 008), so a caller-controlled
//    string cannot reach another bucket, climb out with `..` or add a query. Each segment is
//    percent-encoded.
//  * download() reads the body as a stream and stops at a hard byte cap: a larger object is
//    refused from its content-length, or cancelled mid-stream, and never held whole in memory.
//  * Every call has a timeout, redirects are refused, and a failure carries only a reason and an
//    HTTP status, never the body, the URL or a path.

/** The one bucket the worker reads and removes from (migration 003). */
export const KNOWLEDGE_BUCKET = 'knowledge';

export type StorageErrorReason =
  'http' | 'network' | 'timeout' | 'too_large' | 'invalid_response' | 'etag_mismatch';

export class StorageError extends Error {
  readonly reason: StorageErrorReason;
  readonly status: number | undefined;
  constructor(reason: StorageErrorReason, status?: number) {
    super(
      `storage request failed (${reason}${status === undefined ? '' : `, http ${String(status)}`})`,
    );
    this.name = 'StorageError';
    this.reason = reason;
    this.status = status;
  }
}

export interface DownloadedObject {
  readonly bytes: Uint8Array;
  /** The eTag header as Storage sent it, quoted (compare with normalizeEtag on both sides). */
  readonly etag: string | null;
  readonly contentType: string | null;
}

export interface DownloadOptions {
  /**
   * The eTag the object must have (compared with normalizeEtag). It is checked against the
   * response headers BEFORE the body is read: a missing or different eTag cancels the response and
   * throws StorageError('etag_mismatch'), so an object that is not the registered upload is never
   * downloaded.
   */
  readonly expectedEtag?: string;
}

export interface Storage {
  /**
   * Reads one object, at most `maxBytes`. Throws StorageError('too_large') when the object is
   * larger, StorageError('http', 404) when it does not exist.
   */
  download(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
    options?: DownloadOptions,
  ): Promise<DownloadedObject>;
  /** Removes objects. A path that does not exist is not an error. Returns how many were requested. */
  remove(paths: readonly string[], signal?: AbortSignal): Promise<number>;
}

export interface CreateStorageOptions {
  url: string;
  secretKey: string;
  timeoutMs: number;
  /** Injected for tests only. */
  fetchImpl?: typeof fetch;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// eslint-disable-next-line no-control-regex
const FILENAME = /^[^/\u0000-\u001f\u007f]{1,255}$/;
const PATH_SHAPE = new RegExp(`^(${UUID})/(${UUID})/(${UUID})/(.+)$`);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Storage removes at most this many objects per request. */
const REMOVE_BATCH = 100;
/** One cleanup call may remove at most this many paths (a defence against a runaway caller). */
const MAX_REMOVE_PATHS = 10_000;

/** True for a storage_path of the shape the database accepts. */
export function isSafeObjectPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 400) return false;
  const m = PATH_SHAPE.exec(path);
  if (m === null) return false;
  const filename = m[4] ?? '';
  return FILENAME.test(filename) && !filename.includes('..') && filename !== '.';
}

function checkPath(path: unknown): string {
  if (!isSafeObjectPath(path)) throw new TypeError('invalid storage object path');
  return path;
}

/** Strips a weak marker and the surrounding quotes: `W/"abc"` and `"abc"` both become `abc`. */
export function normalizeEtag(etag: string): string {
  return etag
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
}

export function createStorage(options: CreateStorageOptions): Storage {
  const { url, secretKey, timeoutMs } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new TypeError('storage secret key is required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('storage timeout must be a positive integer (milliseconds)');
  }
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new TypeError('storage URL is not a valid URL');
  }
  const loopback = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new TypeError('storage URL must be https (http is allowed for loopback only)');
  }
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new TypeError('storage URL must not carry credentials, a query or a fragment');
  }
  const objectBase = `${base.origin}${base.pathname.replace(/\/+$/, '')}/storage/v1/object`;

  const authHeaders: Record<string, string> = { apikey: secretKey };
  if (secretKey.split('.').length === 3) authHeaders['authorization'] = `Bearer ${secretKey}`;

  function buildSignal(caller: AbortSignal | undefined): {
    signal: AbortSignal;
    timeout: AbortSignal;
  } {
    const timeout = AbortSignal.timeout(timeoutMs);
    return { signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]), timeout };
  }

  async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
    const body = res.body;
    if (body === null) throw new StorageError('invalid_response', res.status);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new StorageError('too_large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }

  return {
    async download(path, maxBytes, signal, options) {
      const safe = checkPath(path);
      if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new TypeError('maxBytes must be a positive integer');
      }
      const encoded = safe.split('/').map(encodeURIComponent).join('/');
      const { signal: sig, timeout } = buildSignal(signal);
      try {
        const res = await fetchImpl(`${objectBase}/authenticated/${KNOWLEDGE_BUCKET}/${encoded}`, {
          method: 'GET',
          headers: authHeaders,
          redirect: 'error',
          signal: sig,
        });
        if (!res.ok) {
          await res.body?.cancel();
          throw new StorageError('http', res.status);
        }
        const etag = res.headers.get('etag');
        if (
          options?.expectedEtag !== undefined &&
          (etag === null || normalizeEtag(etag) !== normalizeEtag(options.expectedEtag))
        ) {
          await res.body?.cancel();
          throw new StorageError('etag_mismatch');
        }
        const declared = res.headers.get('content-length');
        if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
          await res.body?.cancel();
          throw new StorageError('too_large');
        }
        const bytes = await readCapped(res, maxBytes);
        return {
          bytes,
          etag,
          contentType: res.headers.get('content-type'),
        };
      } catch (err) {
        if (err instanceof StorageError) throw err;
        throw new StorageError(timeout.aborted ? 'timeout' : 'network');
      }
    },

    async remove(paths, signal) {
      if (paths.length > MAX_REMOVE_PATHS) throw new TypeError('too many paths to remove');
      const safe = paths.map(checkPath);
      for (let i = 0; i < safe.length; i += REMOVE_BATCH) {
        const batch = safe.slice(i, i + REMOVE_BATCH);
        const { signal: sig, timeout } = buildSignal(signal);
        try {
          const res = await fetchImpl(`${objectBase}/${KNOWLEDGE_BUCKET}`, {
            method: 'DELETE',
            headers: { ...authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ prefixes: batch }),
            redirect: 'error',
            signal: sig,
          });
          await res.body?.cancel();
          if (!res.ok) throw new StorageError('http', res.status);
        } catch (err) {
          if (err instanceof StorageError) throw err;
          throw new StorageError(timeout.aborted ? 'timeout' : 'network');
        }
      }
      return safe.length;
    },
  };
}
