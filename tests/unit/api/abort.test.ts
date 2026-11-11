import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { raceAbort } from '../../../api/src/lib/abort.ts';

// P7-D2 F1: raceAbort used to reject early on a pre-aborted signal without handling the promise it
// was given. If that promise then rejected, nobody was listening: an unhandled rejection, which
// main.ts answers by exiting the process.

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('raceAbort (P7-D2 F1)', () => {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  let saved: NodeJS.UnhandledRejectionListener[] = [];

  beforeEach(() => {
    seen.length = 0;
    // Vitest reports an unhandled rejection as an error of its own; this test looks at the event
    // itself, so the runner's listeners are set aside for its duration.
    saved = process.listeners('unhandledRejection');
    process.removeAllListeners('unhandledRejection');
    process.on('unhandledRejection', listener);
  });
  afterEach(() => {
    process.off('unhandledRejection', listener);
    for (const l of saved) process.on('unhandledRejection', l);
  });

  it('a pre-aborted signal and a rejecting promise produce no unhandledRejection', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const raced = raceAbort(Promise.reject(new Error('provider failed')), ctl.signal);
    await expect(raced).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(seen).toEqual([]);
  });

  it('a pre-aborted signal and a promise that rejects later produce no unhandledRejection', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const late = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 5);
    });
    await expect(raceAbort(late, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await tick();
    expect(seen).toEqual([]);
  });

  it('an abort that wins the race leaves a later rejection handled', async () => {
    const ctl = new AbortController();
    const late = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('late failure')), 10);
    });
    const raced = raceAbort(late, ctl.signal);
    ctl.abort();
    await expect(raced).rejects.toMatchObject({ name: 'AbortError' });
    await tick(40);
    expect(seen).toEqual([]);
  });

  it('still passes the value or the error of a promise that settles first', async () => {
    const ctl = new AbortController();
    await expect(raceAbort(Promise.resolve(7), ctl.signal)).resolves.toBe(7);
    await expect(raceAbort(Promise.reject(new Error('boom')), ctl.signal)).rejects.toThrow('boom');
    await tick();
    expect(seen).toEqual([]);
  });

  it('removes its listener once the promise settles', async () => {
    const ctl = new AbortController();
    await raceAbort(Promise.resolve(1), ctl.signal);
    ctl.abort(); // nothing left to reject; must not throw
    await tick();
    expect(seen).toEqual([]);
  });
});
