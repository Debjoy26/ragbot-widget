// P8 widget entry: singleton contract (UI_SCHEMA §2). DOM boot itself is
// exercised by Playwright E2E; here we pin the global name and prove the entry
// module is side-effect free without a DOM (node import must not throw).
import { describe, expect, it } from 'vitest';
import { WIDGET_GLOBAL } from '../../../widget/src/widget.ts';

describe('widget entry', () => {
  it('exposes the documented singleton global name', () => {
    expect(WIDGET_GLOBAL).toBe('__ragbotWidget');
  });

  it('does not touch the DOM on import in node', () => {
    expect(typeof (globalThis as { readonly document?: unknown }).document).toBe('undefined');
  });
});
