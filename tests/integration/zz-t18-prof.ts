// TEMP T18 profiler: api-wiring beforeAll stages.
import { performance } from 'node:perf_hooks';
const t = (l: string, t0: number): number => {
  const n = performance.now();
  console.log(l, Math.round(n - t0), 'ms');
  return n;
};
let t0 = performance.now();
const { getLocalStack, getLocalPrivilegedKey } = await import('./helpers/local-stack.ts');
t0 = t('import helper', t0);
getLocalStack();
t0 = t('getLocalStack', t0);
const key = getLocalPrivilegedKey();
t('getLocalPrivilegedKey', t0);
console.log('done', key.slice(0, 8));
