import { createApp } from './app.js';
import { ConfigError, type AppConfig } from './lib/config.js';

let app: ReturnType<typeof createApp>['app'];
let config: AppConfig;
try {
  ({ app, config } = createApp(process.env));
} catch (err) {
  // Variable names only; never print values or the environment (handover §4.13).
  if (err instanceof ConfigError) {
    const names = err.variables.length > 0 ? err.variables.join(', ') : 'AI provider settings';
    console.error(`Invalid configuration, refusing to start. Check: ${names}`);
  } else {
    console.error('Configuration could not be loaded, refusing to start.');
  }
  process.exit(1);
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // In-flight requests cannot outlive REQUEST_TIMEOUT_MS, so it bounds the drain.
  const force = setTimeout(() => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  }, config.requestTimeoutMs);
  force.unref();
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch {
  app.log.error('failed to listen');
  process.exit(1);
}
