import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from '../../../shared/src/ai/index.ts';

// P7-AI: cost estimate math and input validation.

const price = { inputPerMillion: 0.1, outputPerMillion: 0.4 };

describe('estimateCostUsd', () => {
  it('prices input and output separately, per million tokens', () => {
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, price)).toBe(0.1);
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }, price)).toBe(0.4);
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price)).toBe(0.5);
    expect(
      estimateCostUsd(
        { inputTokens: 2_500_000, outputTokens: 500_000 },
        { inputPerMillion: 3, outputPerMillion: 15 },
      ),
    ).toBe(15);
  });

  it('rounds to 6 decimals', () => {
    // 1234 * 0.1 / 1e6 = 0.0001234 and 567 * 0.4 / 1e6 = 0.0002268: total 0.0003502
    expect(estimateCostUsd({ inputTokens: 1234, outputTokens: 567 }, price)).toBe(0.00035);
    // 3 * 0.1 / 1e6 = 3e-7 rounds to 0; 5 * 0.1 / 1e6 = 5e-7 rounds up to 1e-6
    expect(estimateCostUsd({ inputTokens: 3, outputTokens: 0 }, price)).toBe(0);
    expect(estimateCostUsd({ inputTokens: 5, outputTokens: 0 }, price)).toBe(0.000001);
    const odd = estimateCostUsd(
      { inputTokens: 777_777, outputTokens: 333_333 },
      { inputPerMillion: 0.123456, outputPerMillion: 0.654321 },
    );
    expect(odd).toBe(Number(odd.toFixed(6)));
    expect(odd).toBe(0.314128);
  });

  it('is zero for no usage or a free model, never negative', () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0 }, price)).toBe(0);
    expect(
      estimateCostUsd(
        { inputTokens: 10, outputTokens: 10 },
        { inputPerMillion: 0, outputPerMillion: 0 },
      ),
    ).toBe(0);
  });

  it('ignores cached input tokens: all input is priced at the full rate', () => {
    expect(
      estimateCostUsd(
        { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 },
        price,
      ),
    ).toBe(0.1);
  });

  it('is monotonic in tokens', () => {
    let previous = -1;
    for (let n = 0; n <= 5_000_000; n += 250_000) {
      const cost = estimateCostUsd({ inputTokens: n, outputTokens: n / 2 }, price);
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
  });

  it.each([
    ['negative input tokens', { inputTokens: -1, outputTokens: 0 }, price],
    ['negative output tokens', { inputTokens: 0, outputTokens: -1 }, price],
    ['NaN input tokens', { inputTokens: Number.NaN, outputTokens: 0 }, price],
    ['infinite output tokens', { inputTokens: 0, outputTokens: Infinity }, price],
    [
      'negative input price',
      { inputTokens: 1, outputTokens: 1 },
      { inputPerMillion: -0.1, outputPerMillion: 1 },
    ],
    [
      'negative output price',
      { inputTokens: 1, outputTokens: 1 },
      { inputPerMillion: 1, outputPerMillion: -1 },
    ],
    [
      'NaN price',
      { inputTokens: 1, outputTokens: 1 },
      { inputPerMillion: Number.NaN, outputPerMillion: 1 },
    ],
    [
      'infinite price',
      { inputTokens: 1, outputTokens: 1 },
      { inputPerMillion: 1, outputPerMillion: Infinity },
    ],
  ])('throws a RangeError for %s', (_name, usage, p) => {
    expect(() => estimateCostUsd(usage, p)).toThrow(RangeError);
  });

  it('throws a RangeError for a missing or non-numeric field instead of returning NaN', () => {
    const bad = (v: unknown): never => v as never;
    expect(() => estimateCostUsd(bad({ outputTokens: 1 }), price)).toThrow(RangeError);
    expect(() =>
      estimateCostUsd({ inputTokens: 1, outputTokens: 1 }, bad({ inputPerMillion: 1 })),
    ).toThrow(RangeError);
    expect(() => estimateCostUsd(bad({ inputTokens: '5', outputTokens: 1 }), price)).toThrow(
      RangeError,
    );
  });

  it('throws a RangeError when the product overflows to infinity', () => {
    expect(() =>
      estimateCostUsd(
        { inputTokens: Number.MAX_VALUE, outputTokens: 0 },
        { inputPerMillion: Number.MAX_VALUE, outputPerMillion: 0 },
      ),
    ).toThrow(RangeError);
  });
});
