// Actual operational SQL on the LOCAL DB; all usage/identity rows are synthetic.
// Pipe the query through psql: Supabase's pgTAP mount excludes root scripts/.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';

interface Metric {
  bot_id: string;
  answer_hits: number;
  generations: number;
}
let metrics: Metric[];
beforeAll(() => {
  const config = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8');
  const project = /^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m.exec(config)?.[1];
  if (project === undefined) throw new Error('local test project is missing');
  const id = randomUUID();
  const query = readFileSync(
    new URL('../../scripts/sql/cache-hit-metrics.sql', import.meta.url),
    'utf8',
  )
    .trim()
    .replace(/;$/, '');
  const input = `begin;
    insert into public.bot_profiles(id,slug,identity_prompt,tone,scope,allowed_languages,embedding_model,embedding_dimensions)
      values('${id}','metrics-${id}','FAKE identity','neutral','FAKE scope',array['en'],'fake',1536);
    insert into public.usage_events(bot_id,provider,model,operation,input_tokens,output_tokens,estimated_cost)
      values ('${id}','gemini','fake-model','chat',1,1,0.01),
        ('${id}','cache','answer_cache','chat',0,0,0),
        ('${id}','cache','answer_cache','answer_cache_hit',0,0,0),
        ('${id}',null,null,'chat',1,1,0.02);
    select coalesce(jsonb_agg(metrics), '[]'::jsonb) from (
      ${query}
    ) metrics where bot_id='${id}';
    rollback;
  `;
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      `supabase_db_${project}`,
      'psql',
      '-U',
      'postgres',
      '-X',
      '-q',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      '-',
    ],
    {
      input,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 1 << 20,
    },
  );
  metrics = JSON.parse(output.trim()) as Metric[];
}, 90_000);

it('returns one hourly aggregate for the fixture bot', () => {
  expect(metrics).toHaveLength(1);
});
it('counts canonical and deployed legacy cache identities as hits', () => {
  expect(metrics[0]?.answer_hits).toBe(2);
});
it('counts only provider generations including an unknown provider', () => {
  expect(metrics[0]?.generations).toBe(2);
});
it('classifies each usage call once', () => {
  expect((metrics[0]?.answer_hits ?? 0) + (metrics[0]?.generations ?? 0)).toBe(4);
});
