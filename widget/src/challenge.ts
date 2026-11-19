// Turnstile is acquired lazily for a new session only. The site key is public;
// the API remains responsible for verification and the required-bot policy.
import { TURNSTILE_SESSION_ACTION } from '../../shared/src/contracts.js';

interface Turnstile {
  readonly render: (container: HTMLElement, options: Readonly<Record<string, unknown>>) => string;
  readonly remove: (id: string) => void;
}

let loading: Promise<Turnstile> | undefined;

function currentApi(): Turnstile | undefined {
  const value = (window as unknown as { turnstile?: Turnstile }).turnstile;
  return typeof value?.render === 'function' && typeof value.remove === 'function'
    ? value
    : undefined;
}

function loadTurnstile(): Promise<Turnstile> {
  const existing = currentApi();
  if (existing !== undefined) return Promise.resolve(existing);
  if (loading !== undefined) return loading;
  loading = new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timer = window.setTimeout(failed, 15_000);
    function failed(): void {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      reject(new Error('CHALLENGE_FAILED'));
    }
    script.onerror = failed;
    script.onload = () => {
      const api = currentApi();
      if (api === undefined) return failed();
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      resolve(api);
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // A blocked/offline script must not poison subsequent user retries.
    loading = undefined;
    throw error;
  });
  return loading;
}

export function requestChallenge(args: {
  readonly host: HTMLElement;
  readonly siteKey: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { host, siteKey, signal } = args;
  if (signal.aborted) return Promise.reject(new Error('CHALLENGE_FAILED'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let api: Turnstile | undefined;
    let widgetId: string | undefined;
    // Keep vendor DOM in the light tree; project it into the panel with a slot.
    // An interactive site key can therefore show its challenge accessibly too.
    const container = document.createElement('div');
    container.slot = 'verification';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Session verification');
    container.style.cssText = 'all:initial;display:block;padding:8px 12px;';
    const timer = window.setTimeout(failed, 120_000);
    function removeWidget(): void {
      if (api !== undefined && widgetId !== undefined) {
        try {
          api.remove(widgetId);
        } catch {
          // Cleanup failure never allows an unverified session request.
        }
      }
      container.remove();
    }
    function finish(token?: string): void {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', failed);
      removeWidget();
      if (typeof token === 'string' && token.length > 0 && token.length <= 4096) resolve(token);
      else reject(new Error('CHALLENGE_FAILED'));
    }
    function failed(): void {
      finish();
    }
    signal.addEventListener('abort', failed, { once: true });
    void loadTurnstile()
      .then((loaded) => {
        if (settled) return;
        api = loaded;
        host.appendChild(container);
        widgetId = api.render(container, {
          sitekey: siteKey,
          action: TURNSTILE_SESSION_ACTION,
          size: 'compact',
          retry: 'never',
          'refresh-expired': 'never',
          'refresh-timeout': 'never',
          'response-field': false,
          callback: finish,
          'error-callback': failed,
          'expired-callback': failed,
          'timeout-callback': failed,
          'unsupported-callback': failed,
        });
        // Also clean up a vendor that invokes its callback during render().
        if (settled) removeWidget();
      })
      .catch(failed);
  });
}
