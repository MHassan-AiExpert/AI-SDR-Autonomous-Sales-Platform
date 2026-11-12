import { loadConfig } from './config.ts';
import { connect, Store } from './store.ts';
import { createAgentServer } from './server.ts';
import { log } from './log.ts';

const config = loadConfig();
const sql = connect(config.databaseUrl);
const store = new Store(sql);
const server = createAgentServer(
  { store, models: config.models, scheduleHours: config.scheduleHours, appUrl: config.appUrl, webhookBaseUrl: config.webhookBaseUrl },
  { hmacSecret: config.hmacSecret, jobsPerRun: config.jobsPerRun, healthCheck: async () => { await sql`select 1`; } },
);

server.listen(config.port, () => log('info', 'agent service listening', { port: config.port }));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    server.close(() => void sql.end({ timeout: 5 }).then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
