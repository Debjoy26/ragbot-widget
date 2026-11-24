export declare const WIDGET_KEY_RE: RegExp;
export declare function makeWidgetKey(): string;
export declare function fingerprintWidgetKey(raw: string): string;
export declare function buildEmbedSnippet(args: {
  readonly apiUrl: string;
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly botSlug: string;
  readonly widgetKey: string;
  readonly widgetJsUrl: string;
}): string;
export declare const PROVISION_STEPS: readonly string[];
