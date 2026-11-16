import { describe, expect, it } from 'vitest';

// P10-T2: pure helpers of scripts/smoke-test.mjs (no child process, no DB).

import {
  checkJsonErrorContract,
  checkLiveContract,
  evaluateSLO,
  parseSSEEvents,
} from '../../scripts/smoke-test.mjs';

describe('parseSSEEvents', () => {
  it('splits event/data blocks in order', () => {
    const events = parseSSEEvents('event: meta\ndata: {"a":1}\n\nevent: done\ndata: {}\n\n');
    expect(events).toEqual([
      { event: 'meta', data: '{"a":1}' },
      { event: 'done', data: '{}' },
    ]);
  });

  it('skips comment-only blocks', () => {
    expect(parseSSEEvents(':heartbeat\n\n')).toEqual([]);
  });
});

describe('checkJsonErrorContract', () => {
  it('accepts a stable code with no leak', () => {
    expect(checkJsonErrorContract({ code: 'INTERNAL_ERROR' }, ['shh-secret'])).toEqual([]);
  });

  it('rejects unstable codes, stacks and secrets', () => {
    expect(checkJsonErrorContract({ code: 'WEIRD' }, [])).toHaveLength(1);
    expect(
      checkJsonErrorContract({ code: 'INTERNAL_ERROR', stack: 'at x (y:1:2)' }, []),
    ).toHaveLength(1);
    expect(
      checkJsonErrorContract({ code: 'INTERNAL_ERROR', detail: 'has shh-secret inside' }, [
        'shh-secret',
      ]),
    ).toHaveLength(1);
    expect(checkJsonErrorContract(null, [])).toHaveLength(1);
  });
});

describe('checkLiveContract', () => {
  const meta = { event: 'meta', data: '{}' };
  const handoff = { event: 'handoff', data: '{"reason":"no_knowledge"}' };
  const done = { event: 'done', data: '{}' };

  it('accepts meta-first, handoff, done-last', () => {
    expect(checkLiveContract([meta, handoff, done], [])).toEqual([]);
  });

  it('rejects missing handoff and wrong order', () => {
    expect(checkLiveContract([meta, done], [])).not.toEqual([]);
    expect(checkLiveContract([done, handoff, meta], [])).not.toEqual([]);
    expect(
      checkLiveContract(
        [meta, { event: 'handoff', data: '{"reason":"human_requested"}' }, done],
        [],
      ),
    ).not.toEqual([]);
  });
});

describe('evaluateSLO', () => {
  it('passes within targets, warns past 1x, fails past 2x', () => {
    expect(evaluateSLO({ ttftMs: 100, totalMs: 200 }).failed).toBe(false);
    const warn = evaluateSLO({ ttftMs: 6000, totalMs: 200 });
    expect(warn.failed).toBe(false);
    expect(warn.ttftVerdict).toBe('warn');
    expect(evaluateSLO({ ttftMs: 100, totalMs: 50000 }).failed).toBe(true);
  });
});
