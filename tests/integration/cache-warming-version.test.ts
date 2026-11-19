// Real local SQL, including the existing BEFORE settings-version trigger.
// Pending020 and all synthetic rows are contained in a rolled-back transaction.
import { beforeAll, describe, expect, it } from 'vitest';
import { withWarmingSchema } from './helpers/warming-sql.ts';

interface Result {
  name: string;
  settings_changed: boolean;
  corpus_delta: number;
  jobs: number;
  latest_versions_match: boolean | null;
}
interface Case {
  name: string;
  initialEnabled: boolean;
  killSwitch?: boolean;
  mutation: string;
  settingsChanged: boolean;
  corpusDelta?: number;
  jobs: number;
}
const cases: Case[] = [
  {
    name: 'tone change',
    initialEnabled: true,
    mutation: "update public.bot_profiles set tone='FAKE updated tone' where id=v_bot",
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'identity change',
    initialEnabled: true,
    mutation:
      "update public.bot_profiles set identity_prompt='FAKE updated identity' where id=v_bot",
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'scope change',
    initialEnabled: true,
    mutation: "update public.bot_profiles set scope='FAKE updated scope' where id=v_bot",
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'language change',
    initialEnabled: true,
    mutation: "update public.bot_profiles set allowed_languages=array['en','hi'] where id=v_bot",
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'enable change',
    initialEnabled: false,
    mutation: 'update public.bot_profiles set enabled=true where id=v_bot',
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'explicit corpus change',
    initialEnabled: true,
    mutation: 'update public.bot_profiles set corpus_version=corpus_version+1 where id=v_bot',
    settingsChanged: false,
    corpusDelta: 1,
    jobs: 1,
  },
  {
    name: 'explicit settings version',
    initialEnabled: true,
    mutation: 'update public.bot_profiles set settings_version=settings_version+1 where id=v_bot',
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'unchanged tone',
    initialEnabled: true,
    mutation: 'update public.bot_profiles set tone=tone where id=v_bot',
    settingsChanged: false,
    jobs: 0,
  },
  {
    name: 'disabled bot tone',
    initialEnabled: false,
    mutation: "update public.bot_profiles set tone='FAKE updated tone' where id=v_bot",
    settingsChanged: true,
    jobs: 0,
  },
  {
    name: 'kill switch tone',
    initialEnabled: true,
    killSwitch: true,
    mutation: "update public.bot_profiles set tone='FAKE updated tone' where id=v_bot",
    settingsChanged: true,
    jobs: 0,
  },
  {
    name: 'client settings change',
    initialEnabled: true,
    mutation: `update public.client_settings set cache_policy=cache_policy || '{"c4":false}'::jsonb where bot_id=v_bot`,
    settingsChanged: true,
    jobs: 1,
  },
  {
    name: 'public questions change',
    initialEnabled: true,
    mutation: `update public.public_bot_config set suggested_questions='["FAKE new question"]'::jsonb where bot_id=v_bot`,
    settingsChanged: true,
    jobs: 1,
  },
];
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
let results: Result[];
beforeAll(() => {
  const blocks = cases
    .map(
      (c) => `do $case$
    declare v_bot uuid:=gen_random_uuid(); v_before_corpus bigint; v_after_corpus bigint;
      v_before_settings integer; v_after_settings integer; v_jobs integer; v_match boolean;
    begin
      insert into public.bot_profiles(id,slug,enabled,identity_prompt,tone,scope,
        allowed_languages,embedding_model,embedding_dimensions)
      values(v_bot,'warm-version-' || v_bot::text,${c.initialEnabled},'FAKE identity',
        'neutral','FAKE scope',array['en'],'fake',1536);
      insert into public.client_settings(bot_id,allowed_origins,rate_policy,budget_policy,
        retention_policy,upload_policy,handoff_policy,cache_policy,feature_flags)
      values(v_bot,array[]::text[],'{}','{"daily_cap_usd":1}',
        '{"conversation_days":90,"usage_months":13}','{}','{}',
        jsonb_build_object('warm_enabled',true,'warm_max_attempts',3,'kill_switch',${c.killSwitch ?? false}),'{}');
      insert into public.public_bot_config(bot_id,bot_slug,display_name,greeting,
        suggested_questions,primary_color,position,supported_languages,
        escalation_label,escalation_messages,contact_email)
      values(v_bot,'warm-version-' || v_bot::text,'FAKE bot','FAKE greeting','[]',
        '#3155D9','bottom-right',array['en'],'Contact','{"en":"FAKE help"}','help@example.com');
      select corpus_version,settings_version into v_before_corpus,v_before_settings
        from public.bot_profiles where id=v_bot;
      ${c.mutation};
      select corpus_version,settings_version into v_after_corpus,v_after_settings
        from public.bot_profiles where id=v_bot;
      select count(*)::integer, bool_and(payload->>'corpus_version'=v_after_corpus::text
        and payload->>'settings_version'=v_after_settings::text) into v_jobs,v_match
        from public.jobs where type='warm_answer_cache' and payload->>'bot_id'=v_bot::text;
      insert into warm_version_results values(${literal(c.name)},
        v_after_settings>v_before_settings,(v_after_corpus-v_before_corpus)::integer,v_jobs,v_match);
    end;
  $case$;`,
    )
    .join('\n');
  results = JSON.parse(
    withWarmingSchema(`
    create temporary table warm_version_results(name text,settings_changed boolean,
      corpus_delta integer,jobs integer,latest_versions_match boolean) on commit drop;
    ${blocks}
    select coalesce(jsonb_agg(r order by name),'[]'::jsonb) from warm_version_results r;
  `),
  ) as Result[];
}, 90_000);

describe('warming follows actual versions including BEFORE-derived updates', () => {
  it.each(cases)('$name', (c) => {
    expect(results.find((r) => r.name === c.name)).toEqual({
      name: c.name,
      settings_changed: c.settingsChanged,
      corpus_delta: c.corpusDelta ?? 0,
      jobs: c.jobs,
      latest_versions_match: c.jobs === 0 ? null : true,
    });
  });
});
