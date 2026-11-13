// P8 visitor session: create/refresh the short-lived scoped token and keep it
// in tab-scoped `sessionStorage` (ADR 0009). Never `localStorage`. Reset clears
// locally held context and starts a new authorised conversation (UI_SCHEMA §7).

export interface SessionRecord {
  readonly token: string;
  readonly expiresAt: string;
}

export interface SessionStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

export interface SessionFetch {
  (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly json: () => Promise<unknown>;
  }>;
}

export function sessionStorageKey(botSlug: string): string {
  return `ragbot.session.${botSlug}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when the stored session must not be used. Fails closed on bad data. */
export function isSessionExpired(record: SessionRecord | null, nowMs: number): boolean {
  if (record === null) return true;
  if (!Number.isFinite(nowMs)) return true;
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(expires)) return true;
  if (record.token.length === 0) return true;
  return nowMs >= expires;
}

export function readSession(
  storage: SessionStorage,
  botSlug: string,
  nowMs: number,
): SessionRecord | null {
  let raw: string | null;
  try {
    raw = storage.getItem(sessionStorageKey(botSlug));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    const { token, expiresAt } = parsed as {
      readonly token?: unknown;
      readonly expiresAt?: unknown;
    };
    if (typeof token !== 'string' || typeof expiresAt !== 'string') return null;
    const record: SessionRecord = { token, expiresAt };
    return isSessionExpired(record, nowMs) ? null : record;
  } catch {
    return null;
  }
}

export function writeSession(
  storage: SessionStorage,
  botSlug: string,
  record: SessionRecord,
): void {
  try {
    storage.setItem(sessionStorageKey(botSlug), JSON.stringify(record));
  } catch {
    // Storage failures fail closed at read time; never throw here.
  }
}

export function clearSession(storage: SessionStorage, botSlug: string): void {
  try {
    storage.removeItem(sessionStorageKey(botSlug));
  } catch {
    // Ignore: a missing store means there is nothing to clear.
  }
}

/**
 * POST /v1/sessions. `getChallengeToken` supplies the Turnstile token when the
 * bot requires it; the action rendered must be `session_create`
 * (`TURNSTILE_SESSION_ACTION` in shared). The response token is stored and
 * returned. Throws with a stable code word for the UI state machine.
 */
export async function createSession(args: {
  readonly apiUrl: string;
  readonly botSlug: string;
  readonly fetchFn: SessionFetch;
  readonly storage: SessionStorage;
  readonly nowMs: number;
  readonly getChallengeToken?: (() => Promise<string | null>) | undefined;
}): Promise<SessionRecord> {
  const { apiUrl, botSlug, fetchFn, storage, nowMs, getChallengeToken } = args;
  const existing = readSession(storage, botSlug, nowMs);
  if (existing !== null) return existing;

  let challengeToken: string | null = null;
  if (getChallengeToken !== undefined) {
    challengeToken = await getChallengeToken();
  }
  const body: Record<string, string> = { bot_slug: botSlug };
  if (challengeToken !== null && challengeToken.length > 0) {
    body['challenge_token'] = challengeToken;
  }
  const response = await fetchFn(`${apiUrl.replace(/\/$/, '')}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error('RATE_LIMITED');
    if (response.status === 403) throw new Error('FORBIDDEN');
    throw new Error('SESSION_FAILED');
  }
  const parsed = (await response.json()) as unknown;
  if (!isRecord(parsed)) throw new Error('SESSION_FAILED');
  const { token, expires_at: expiresAt } = parsed as {
    readonly token?: unknown;
    readonly expires_at?: unknown;
  };
  if (typeof token !== 'string' || token.length === 0) throw new Error('SESSION_FAILED');
  if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error('SESSION_FAILED');
  }
  const record: SessionRecord = { token, expiresAt };
  writeSession(storage, botSlug, record);
  return record;
}
