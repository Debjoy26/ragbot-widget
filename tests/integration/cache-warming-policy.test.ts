// Actual local Postgres. On019 the pending020 file is replayed INSIDE this
// rolled-back transaction; on020+ the applied functions are tested directly.
// No provider calls, persisted fixtures, schema changes or migration history.
import { beforeAll, describe, expect, it } from 'vitest';
import { withWarmingSchema } from './helpers/warming-sql.ts';

interface Result {
  name: string;
  sqlstate: string;
  corpus_delta: number;
  jobs: number;
  max_attempts: number | null;
}
interface Case {
  name: string;
  policy: Record<string, unknown>;
  enabled: boolean;
  expected: Omit<Result, 'name'>;
}
const cases: Case[] = [
  ...[1, 3, 10].map((limit) => ({
    name: `valid retry limit ${limit}`,
    policy: { warm_enabled: true, warm_max_attempts: limit },
    enabled: true,
    expected: { sqlstate: '00000', corpus_delta: 1, jobs: 1, max_attempts: limit },
  })),
  ...[
    { label: 'missing', value: undefined },
    { label: 'null', value: null },
    { label: 'zero', value: 0 },
    { label: 'negative', value: -1 },
    { label: 'above maximum', value: 11 },
    { label: 'fractional', value: 1.5 },
    { label: 'string', value: '3' },
    { label: 'boolean', value: true },
  ].map(({ label, value }) => ({
    name: `invalid retry limit ${label} leaves original version unchanged`,
    policy: { warm_enabled: true, warm_max_attempts: value },
    enabled: true,
    expected: { sqlstate: '22023', corpus_delta: 0, jobs: 0, max_attempts: null },
  })),
  ...[
    { name: 'disabled bot', enabled: false, policy: { warm_enabled: true } },
    { name: 'warming off', enabled: true, policy: { warm_enabled: false } },
    {
      name: 'global kill switch',
      enabled: true,
      policy: { warm_enabled: true, kill_switch: true },
    },
  ].map((c) => ({
    ...c,
    expected: { sqlstate: '00000', corpus_delta: 1, jobs: 0, max_attempts: null },
  })),
];

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
let results: Result[];
beforeAll(() => {
  const blocks = cases
    .map(
      (c) => `do $case$
    declare v_bot uuid := gen_random_uuid(); v_before bigint; v_after bigint;
      v_state text := '00000'; v_count integer; v_attempts integer;
    begin
      insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
        allowed_languages,embedding_model,embedding_dimensions)
      values(v_bot,'warm-policy-' || v_bot::text,false,'FAKE identity','neutral',
        'FAKE scope',array['en'],'fake',1536);
      insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
        retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
      values(v_bot,array[]::text[],'{}','{"daily_cap_usd":1}',
        '{"conversation_days":90,"usage_months":13}','{}','{}',
        ${literal(JSON.stringify(c.policy))}::jsonb,'{}');
      select corpus_version into v_before from public.bot_profiles where id = v_bot;
      begin
        update public.bot_profiles set enabled = ${c.enabled}, corpus_version = corpus_version + 1 where id = v_bot;
      exception when others then v_state := sqlstate;
      end;
      select corpus_version into v_after from public.bot_profiles where id = v_bot;
      select count(*)::integer, max(max_attempts) into v_count, v_attempts
        from public.jobs where type='warm_answer_cache' and payload->>'bot_id'=v_bot::text;
      insert into warm_policy_results values(${literal(c.name)},v_state,
        (v_after-v_before)::integer,v_count,v_attempts);
    end;
  $case$;`,
    )
    .join('\n');
  const output = withWarmingSchema(`
    create temporary table warm_policy_results(name text,sqlstate text,corpus_delta integer,
      jobs integer,max_attempts integer) on commit drop;
    ${blocks}
    select coalesce(jsonb_agg(r order by name),'[]'::jsonb) from warm_policy_results r;
    `);
  results = JSON.parse(output) as Result[];
}, 90_000);

describe('warming retry policy and originating update atomicity (real local SQL)', () => {
  it.each(cases)('$name', (c) => {
    expect(results.find((r) => r.name === c.name)).toEqual({ name: c.name, ...c.expected });
  });
});
