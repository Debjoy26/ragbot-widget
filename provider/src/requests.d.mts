export declare const CLIENT_STATES: readonly string[];
export declare const DEPLOY_STATES: readonly string[];
export interface PortalClient {
  readonly name: string;
  readonly contact_email: string;
  readonly status: string;
  readonly [key: string]: unknown;
}
export interface DeploymentRecord {
  readonly state: string;
  readonly [key: string]: unknown;
}
export declare function createClient(args: {
  readonly name: string;
  readonly email: string;
}): PortalClient;
export declare function requestService(args: {
  readonly client: PortalClient | null | undefined;
  readonly botSlug: string;
  readonly botName: string;
  readonly origin: string;
  readonly plan: string;
}): {
  readonly bot_slug: string;
  readonly bot_name: string;
  readonly website_origin: string;
  readonly allowed_host: string;
  readonly plan: string;
  readonly state: string;
};
export declare function approveDeployment(dep: DeploymentRecord): DeploymentRecord;
export declare function markLive(
  dep: DeploymentRecord,
  args: {
    readonly supabaseRef: string;
    readonly apiUrl: string;
    readonly widgetUrl: string;
    readonly widgetKey: string;
  },
): DeploymentRecord;
export declare function scriptVisible(dep: DeploymentRecord | null | undefined): boolean;
