// Types for the pure helpers exported by smoke-test.mjs (P10-T2).
// The script itself is JavaScript; the test program gets its shape here.
export declare const TTFT_TARGET_MS: number;
export declare const TOTAL_TARGET_MS: number;
export interface SSEEvent {
  readonly event: string;
  readonly data: string;
}
export declare function parseSSEEvents(text: string): SSEEvent[];
export declare function checkJsonErrorContract(
  json: unknown,
  secrets: readonly unknown[],
): string[];
export declare function checkLiveContract(
  events: readonly SSEEvent[],
  secrets: readonly unknown[],
): string[];
export declare function evaluateSLO(input: { ttftMs: number; totalMs: number }): {
  ttftMs: number;
  totalMs: number;
  ttftVerdict: 'pass' | 'warn' | 'fail';
  totalVerdict: 'pass' | 'warn' | 'fail';
  failed: boolean;
};
