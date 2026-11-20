// Runtime-only fake CLI responses. No Docker, network, or real credentials.
import { beforeEach, expect, it, vi } from 'vitest';
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execute }));
import {
  getLocalStack,
  getLocalPrivilegedKey,
  resetLocalStackCacheForTests,
} from '../integration/helpers/local-stack.ts';
beforeEach(() => {
  execute.mockReset();
  resetLocalStackCacheForTests();
});
function status(url = 'http://127.0.0.1:54321') {
  return {
    API_URL: url,
    ANON_KEY: `fake_${crypto.randomUUID()}`,
    SERVICE_ROLE_KEY: 'fake-' + crypto.randomUUID(),
  };
}
it('runs the pinned JS CLI directly with fixed arguments and no command shell', () => {
  const data = status();
  execute.mockReturnValue(JSON.stringify(data));
  expect(getLocalStack().apiUrl).toBe(data.API_URL);
  const [binary, args, options] = execute.mock.calls[0]!;
  expect(binary).toBe(process.execPath);
  expect(args[0]).toMatch(/node_modules[/\\]supabase[/\\]dist[/\\]supabase\.js$/);
  expect(args.slice(1)).toEqual(['status', '-o', 'json']);
  expect(options.shell).toBeUndefined();
  expect(options.timeout).toBe(60000);
});
it('refuses remote URLs before returning privileged credentials', () => {
  execute.mockReturnValue(JSON.stringify(status('https://remote.invalid')));
  expect(() => getLocalPrivilegedKey()).toThrow('non-loopback');
  expect(execute).toHaveBeenCalledTimes(1);
});
it('does not echo CLI failures or credentials in errors', () => {
  const marker = `fake_${crypto.randomUUID()}`;
  execute.mockImplementation(() => {
    throw Error(marker);
  });
  try {
    getLocalStack();
    throw Error('expected rejection');
  } catch (error) {
    expect(String(error)).toContain('local Supabase stack');
    expect(String(error)).not.toContain(marker);
  }
});
it.each(['[]', 'null', 'not json'])('rejects malformed status %s', (value) => {
  execute.mockReturnValue(value);
  expect(() => getLocalStack()).toThrow();
});
it('reads the stack status once per process across both accessors', () => {
  const data = status();
  execute.mockReturnValue(JSON.stringify(data));
  expect(getLocalStack().apiUrl).toBe(data.API_URL);
  expect(getLocalPrivilegedKey()).toBe(data.SERVICE_ROLE_KEY);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('re-reads the status after a test-only cache reset', () => {
  const data = status();
  execute.mockReturnValue(JSON.stringify(data));
  expect(getLocalStack().apiUrl).toBe(data.API_URL);
  resetLocalStackCacheForTests();
  expect(getLocalStack().apiUrl).toBe(data.API_URL);
  expect(execute).toHaveBeenCalledTimes(2);
});
