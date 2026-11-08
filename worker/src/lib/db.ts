// Server-only PostgREST client for the worker's service (secret) key (P6-QUEUE). Modelled on
// api/src/lib/supabase.ts: same DbError, same opt-in contention retry. Only RPC calls are needed.
// Never import this from the widget, and never pass its results to a log line.
//
// Design rules (handover.md section 4, TECH_SPECS section 8):
//  * The key is held in a closure. It is not a property of any returned object, not in any error,
//    and this module never logs.
//  * Function names are checked against a strict pattern, so a caller-controlled string cannot
//    add a path segment or a query.
//  * Every call is bounded by a timeout (AbortSignal) and redirects are refused, so the key is
//    never forwarded to a second host.
//  * A failure is a DbError carrying only the SQLSTATE and the HTTP status. The URL query and the
//    response body text are never copied into it.

export type DbErrorReason = 'http' | 'network' | 'timeout' | 'invalid_response';

/** Carries only a SQLSTATE and an HTTP status. Never the key, the URL query or any body text. */
export class DbError extends Error {
  readonly reason: DbErrorReason;
  readonly sqlstate: string | undefined;
  readonly status: number | undefined;

  constructor(reason: DbErrorReason, status?: number, sqlstate?: string) {
    super(
      `database request failed (${reason}` +
        `${status === undefined ? '' : `, http ${String(status)}`}` +
        `${sqlstate === undefined ? '' : `, sqlstate ${sqlstate}`})`,
    );
    this.name = 'DbError';
    this.reason = reason;
    this.status = status;
    this.sqlstate = sqlstate;
  }
}

export interface Db {
  /**
   * Calls a database function with a JSON argument object. Throws DbError.
   * `options.retryOnContention` is opt-in: see RpcOptions.
   */
  rpc<T>(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    options?: RpcOptions,
  ): Promise<T>;
}

export interface RpcOptions {
  /**
   * Retry ONCE, after a short jittered delay, when the database rolled the call back for lock
   * contention: SQLSTATE 40P01 (deadlock detected) or 55P03 (lock not available, i.e. lock_timeout).
   * Both mean the statement did not run, so repeating it is safe. Never any other error, and never
   * on by default: a caller opts in per call, only for a function that is safe to repeat (P5, status
   * section 3a az and bf).
   */
  readonly retryOnContention?: boolean;
}

export interface CreateDbOptions {
  url: string;
  secretKey: string;
  timeoutMs: number;
  /** Injected for tests only. */
  fetchImpl?: typeof fetch;
  /** Injected for tests only: waits between a contention failure and its one retry. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injected for tests only: uniform random number in [0, 1) for the retry jitter. */
  randomImpl?: () => number;
}

/** SQLSTATEs that mean "rolled back for lock contention, safe to repeat once". */
export const CONTENTION_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '55P03']);
/** Jittered delay before the one contention retry: between these bounds (milliseconds). */
export const CONTENTION_RETRY_MIN_MS = 20;
export const CONTENTION_RETRY_MAX_MS = 80;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const IDENTIFIER = /^[a-z_]+$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_ERROR_BODY_CHARS = 4096;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function checkIdentifier(kind: string, value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 63 ||
    !IDENTIFIER.test(value)
  ) {
    throw new TypeError(`invalid ${kind} name`);
  }
}

export function createDb(options: CreateDbOptions): Db {
  const { url, secretKey, timeoutMs } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;
  const random = options.randomImpl ?? Math.random;

  // Fail closed on missing or malformed configuration. Messages never include the values.
  if (typeof secretKey !== 'string' || secretKey.length === 0) {
    throw new TypeError('database secret key is required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('database timeout must be a positive integer (milliseconds)');
  }
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new TypeError('database URL is not a valid URL');
  }
  const loopback = LOOPBACK_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new TypeError('database URL must be https (http is allowed for loopback only)');
  }
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new TypeError('database URL must not carry credentials, a query or a fragment');
  }
  const restBase = `${base.origin}${base.pathname.replace(/\/+$/, '')}/rest/v1`;

  // A legacy JWT-style key is also sent as the bearer token; a new-style secret key is not a JWT.
  const authHeaders: Record<string, string> = { apikey: secretKey };
  if (secretKey.split('.').length === 3) authHeaders['authorization'] = `Bearer ${secretKey}`;

  function buildSignal(caller: AbortSignal | undefined): {
    signal: AbortSignal;
    timeout: AbortSignal;
  } {
    const timeout = AbortSignal.timeout(timeoutMs);
    return { signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]), timeout };
  }

  async function send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
    caller: AbortSignal | undefined,
    parse: boolean,
  ): Promise<unknown> {
    const { signal, timeout } = buildSignal(caller);
    try {
      const res = await fetchImpl(`${restBase}${path}`, {
        method: init.method,
        headers: {
          ...authHeaders,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: 'error',
        signal,
      });
      if (!res.ok) {
        throw new DbError('http', res.status, await readSqlstate(res));
      }
      if (!parse) {
        await res.body?.cancel();
        return undefined;
      }
      const text = await res.text();
      if (text.length === 0) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new DbError('invalid_response', res.status);
      }
    } catch (err) {
      if (err instanceof DbError) throw err;
      throw new DbError(timeout.aborted ? 'timeout' : 'network');
    }
  }

  return {
    async rpc<T>(
      name: string,
      args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
      rpcOptions?: RpcOptions,
    ): Promise<T> {
      checkIdentifier('function', name);
      let payload: string;
      try {
        payload = JSON.stringify(args);
      } catch {
        throw new TypeError('rpc arguments are not serialisable');
      }
      const call = (): Promise<unknown> =>
        send(`/rpc/${name}`, { method: 'POST', body: payload }, signal, true);
      if (rpcOptions?.retryOnContention !== true) return (await call()) as T;
      try {
        return (await call()) as T;
      } catch (err) {
        if (
          !(err instanceof DbError) ||
          err.sqlstate === undefined ||
          !CONTENTION_SQLSTATES.has(err.sqlstate) ||
          signal?.aborted === true
        ) {
          throw err;
        }
        const span = CONTENTION_RETRY_MAX_MS - CONTENTION_RETRY_MIN_MS;
        await sleep(CONTENTION_RETRY_MIN_MS + Math.floor(random() * span));
        // One retry only: whatever this attempt throws is final.
        return (await call()) as T;
      }
    },
  };
}

/** Extracts only a well-formed SQLSTATE from a PostgREST error body. The text itself is dropped. */
async function readSqlstate(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'code' in parsed) {
      const code = (parsed as { code: unknown }).code;
      if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    }
  } catch {
    // unreadable or non-JSON body: no SQLSTATE
  }
  return undefined;
}
