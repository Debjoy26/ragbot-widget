// TEMP: list analyze_conversation jobs in local DB.
import { createDb } from '../../worker/src/lib/db.ts';
import { getLocalPrivilegedKey, getLocalStack } from './helpers/local-stack.ts';

const stack = getLocalStack();
const db = createDb({ url: stack.apiUrl, secretKey: getLocalPrivilegedKey(), timeoutMs: 10000 });
const rows = (await db.rpc('claim_jobs', {
  p_worker: 't18-probe',
  p_limit: 20,
  p_lease_seconds: 600,
  p_types: ['analyze_conversation'],
})) as unknown[];
console.log('claimable analyze jobs:', JSON.stringify(rows, null, 1).slice(0, 2000));
for (const r of rows as { id: string }[]) {
  await db
    .rpc('release_job_lease', { p_job_id: (r as { id: string }).id, p_worker: 't18-probe' })
    .catch(() => undefined);
}
console.log('released probe claims');
