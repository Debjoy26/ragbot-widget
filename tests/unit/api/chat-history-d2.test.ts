import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONVERSATION,
  USER_MESSAGE,
  chatBody,
  closeApps,
  parseSse,
  postChat,
  setup,
} from './chat-harness.ts';
import { selectHistory } from '../../../api/src/services/llm.ts';

afterEach(closeApps);

// P7-D2 F2: two concurrent turns in one conversation store their rows interleaved:
//   u_A, u_B, a_A, a_B
// If u_A was refused by input moderation, the question is `blocked` itself (migration 013 sets the
// status on the user row when the turn finishes as blocked) but is NOT directly followed by its
// refusal, so the adjacency rule alone would hand the refused text back to the model.

const m = (role: 'user' | 'assistant', content: string, status = 'complete') => ({
  role,
  content,
  status,
});

describe('selectHistory: a user row that is itself blocked (P7-D2 F2)', () => {
  it('excludes u_A in the interleaved order u_A, u_B, a_A(blocked), a_B(complete)', () => {
    const out = selectHistory(
      [
        m('user', 'REFUSED-QUESTION-TEXT', 'blocked'),
        m('user', 'question B'),
        m('assistant', 'Please contact our team.', 'blocked'),
        m('assistant', 'answer B'),
      ],
      6,
    );
    expect(JSON.stringify(out)).not.toContain('REFUSED-QUESTION-TEXT');
    expect(JSON.stringify(out)).not.toContain('Please contact our team.');
  });

  it('keeps the legitimate question B in the order u_A(blocked), u_B, a_A(blocked), a_B (P7-R4 #1)', () => {
    const out = selectHistory(
      [
        m('user', 'REFUSED-QUESTION-TEXT', 'blocked'),
        m('user', 'question B'),
        m('assistant', 'Please contact our team.', 'blocked'),
        m('assistant', 'answer B'),
      ],
      6,
    );
    expect(out.map((x) => x.content)).toEqual(['question B', 'answer B']);
  });

  it('excludes a blocked user row whatever follows it', () => {
    const out = selectHistory(
      [
        m('user', 'REFUSED-QUESTION-TEXT', 'blocked'),
        m('user', 'question B'),
        m('assistant', 'answer B'),
        m('user', 'q3'),
        m('assistant', 'a3'),
      ],
      6,
    );
    expect(JSON.stringify(out)).not.toContain('REFUSED-QUESTION-TEXT');
    expect(out.map((x) => x.content)).toEqual(['question B', 'answer B', 'q3', 'a3']);
  });

  it('a blocked user row at the end of the rows, or before a complete reply, is excluded', () => {
    expect(
      JSON.stringify(
        selectHistory([m('user', 'q1'), m('assistant', 'a1'), m('user', 'REFUSED', 'blocked')], 6),
      ),
    ).not.toContain('REFUSED');
    expect(
      JSON.stringify(selectHistory([m('user', 'REFUSED', 'blocked'), m('assistant', 'a1')], 6)),
    ).not.toContain('REFUSED');
  });

  it('keeps the adjacency rule: a complete user row followed by a blocked reply is still dropped', () => {
    expect(
      selectHistory(
        [
          m('user', 'q1'),
          m('assistant', 'a1'),
          m('user', 'REFUSED-TEXT'),
          m('assistant', 'refusal', 'blocked'),
        ],
        6,
      ),
    ).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('other statuses on a user row (complete, partial, failed) are kept as before', () => {
    const out = selectHistory(
      [
        m('user', 'q1', 'complete'),
        m('assistant', 'a1'),
        m('user', 'q2', 'failed'),
        m('assistant', 'a2'),
      ],
      6,
    );
    expect(out.map((x) => x.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });
});

describe('history in the prompt: interleaved concurrent turns (P7-D2 F2)', () => {
  const row = (role: string, content: string, status = 'complete', id = randomUUID()) => ({
    id,
    role,
    content,
    status,
    handoff_reason: null,
    created_at: '2026-11-10T10:00:00.000000+00:00',
    has_more: false,
  });

  it('never sends the text of a question whose own status is blocked', async () => {
    const h = setup({
      history: [
        row('user', 'q0'),
        row('assistant', 'a0'),
        row('user', 'REFUSED-QUESTION-TEXT', 'blocked'),
        row('user', 'question B'),
        row('assistant', 'Please contact our team.', 'blocked'),
        row('assistant', 'answer B'),
        row('user', 'How much is the standard plan?', 'complete', USER_MESSAGE),
      ],
    });
    const res = await postChat(h, chatBody({ conversation_id: CONVERSATION }));
    expect(res.statusCode).toBe(200);
    parseSse(res.body);
    const wire = JSON.stringify(h.chatProvider.requests[0]?.messages);
    expect(wire).not.toContain('REFUSED-QUESTION-TEXT');
    expect(wire).not.toContain('Please contact our team.');
  });
});
