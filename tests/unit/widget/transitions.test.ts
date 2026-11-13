// P8-D2 review regressions (R1): the state machine must cover every recovery
// path — retries from terminal states, late terminal events, and no crashing
// self-transitions. Imports only the pure transition table (no DOM).
import { describe, expect, it } from 'vitest';
import { isTransitionAllowed } from '../../../widget/src/ui.ts';
import type { WidgetState } from '../../../widget/src/types.ts';

const STATES: readonly WidgetState[] = [
  'booting',
  'closed',
  'ready',
  'connecting',
  'streaming',
  'limited',
  'blocked',
  'unavailable',
];

describe('widget transition matrix (P8-D2 R1)', () => {
  it('recovers from every terminal state via connecting', () => {
    for (const from of ['limited', 'blocked', 'unavailable'] as const) {
      expect(isTransitionAllowed(from, 'connecting')).toBe(true);
      expect(isTransitionAllowed(from, 'ready')).toBe(true);
      expect(isTransitionAllowed(from, 'closed')).toBe(true);
    }
  });

  it('accepts late terminal events while ready', () => {
    for (const to of ['limited', 'blocked', 'unavailable'] as const) {
      expect(isTransitionAllowed('ready', to)).toBe(true);
    }
  });

  it('reaches closed from every state (Escape always works)', () => {
    for (const from of STATES) {
      if (from === 'booting') continue;
      expect(isTransitionAllowed(from, 'closed')).toBe(true);
    }
  });

  it('rejects impossible jumps', () => {
    expect(isTransitionAllowed('closed', 'streaming')).toBe(false);
    expect(isTransitionAllowed('booting', 'ready')).toBe(false);
    expect(isTransitionAllowed('connecting', 'connecting')).toBe(false);
    expect(isTransitionAllowed('streaming', 'connecting')).toBe(false);
  });
});
