export interface RestoreOptions {
  ref?: string;
  url?: string;
  confirm?: string;
  manifest?: string;
  capture?: string;
}
export type RestoreEnvironment = Readonly<Record<string, string | undefined>>;
export interface RestoreTarget {
  ref: string;
  url: string;
  database: { host: string; port: string; user: string; password: string; sslmode: string };
}
export interface RestoreLimits {
  tables: number;
  objects: number;
  objectBytes: number;
  totalBytes: number;
  jsonBytes: number;
}
export interface ObjectDigest {
  bytes: number;
  sha256: string;
}
export interface RestoreManifest {
  version: number;
  projectRef: string;
  migrations: string[];
  catalogSha256: string;
  bucket: {
    id: string;
    public: boolean;
    file_size_limit?: number | null;
    allowed_mime_types?: string[] | null;
  };
  counts: Record<string, string>;
  objects: (ObjectDigest & { name: string })[];
}
export const LIMITS: Readonly<RestoreLimits>;
export const SQL: Readonly<{
  migrations: string;
  tables: string;
  catalog: string;
  bucket: string;
  objects: string;
}>;
export function validateTarget(options: RestoreOptions, env: RestoreEnvironment): RestoreTarget;
export function countSql(table: string): string;
export interface SqlTransportOptions {
  input: string;
  encoding: string;
  timeout: number;
  maxBuffer: number;
  stdio: string[];
  env: Record<string, string>;
}
export function createSqlReader(
  target: RestoreTarget,
  environment?: RestoreEnvironment,
  execute?: (command: string, args: string[], options: SqlTransportOptions) => string,
): (sql: string) => unknown;
export function digestObject(response: Response, limits?: RestoreLimits): Promise<ObjectDigest>;
export function collect(
  target: RestoreTarget,
  env: RestoreEnvironment,
  dependencies?: {
    sql?: (query: string) => unknown | Promise<unknown>;
    fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
    limits?: RestoreLimits;
  },
): Promise<RestoreManifest>;
export function compareManifest(
  expected: unknown,
  actual: unknown,
): { tables: number; objects: number };
export function parseArgs(args: string[]): RestoreOptions;
export function main(args?: string[], env?: RestoreEnvironment): Promise<number>;
