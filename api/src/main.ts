import { createApp } from './app.js';
import { ConfigError, type AppConfig } from './lib/config.js';
import { armForceExit, errorClassName } from './lib/lifecycle.js';

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
  // First: report not-ready at once, so the load balancer stops routing here while we drain.
  app.beginDrain();
  app.log.info({ signal }, 'shutting down');
  // A chat answer can run up to CHAT_DEADLINE_MS (REQUEST_TIMEOUT_MS only bounds receiving a
  // request), so the longer of the two (plus a margin, capped at the timer limit) bounds the drain.
  armForceExit(config, () => {
    app.log.error('graceful shutdown timed out');
    process.exit(1);
  });
  app.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Last-resort handlers: log the class name only (a message or stack may hold a secret) and exit 1,
// so the platform restarts a process whose state can no longer be trusted.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ error_class: errorClassName(reason) }, 'unhandled rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ error_class: errorClassName(err) }, 'uncaught exception');
  process.exit(1);
});

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
} catch {
  app.log.error('failed to listen');
  process.exit(1);
}
