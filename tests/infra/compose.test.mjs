import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planImport } from '../../infra/n8n/import-workflows.mjs';

const root = new URL('../../', import.meta.url);
const composeText = readFileSync(new URL('infra/docker-compose.yml', root), 'utf8');
const compose = parse(composeText, { merge: true });
const envExample = readFileSync(new URL('infra/.env.example', root), 'utf8');
const services = compose.services;

test('INF-01 stack defines database, queue, workflow import, main instance, workers and the agent service', () => {
  assert.deepEqual(Object.keys(services).sort(), ['agent-service', 'n8n', 'n8n-import', 'n8n-postgres', 'n8n-worker', 'redis']);
});

test('INF-02 every image is pinned to an exact version', () => {
  for (const [name, svc] of Object.entries(services)) {
    assert.match(svc.image, /^[\w./-]+:\d+\.\d+(\.\d+)?(-[\w.]+)?$/, `${name} image must be pinned: ${svc.image}`);
    assert.doesNotMatch(svc.image, /:latest$/);
  }
});

test('INF-03 main instance and workers run the same n8n version', () => {
  assert.equal(services.n8n.image, services['n8n-worker'].image);
});

test('INF-04 every long-running service has a health check and a restart policy', () => {
  for (const [name, svc] of Object.entries(services)) {
    if (name === 'n8n-import') continue; // one-shot job, covered by INF-19
    assert.ok(svc.healthcheck?.test, `${name} needs a healthcheck`);
    assert.equal(svc.restart, 'unless-stopped', `${name} needs a restart policy`);
  }
});

test('INF-05 n8n runs in queue mode on Redis with PostgreSQL', () => {
  for (const name of ['n8n', 'n8n-worker']) {
    const env = services[name].environment;
    assert.equal(env.EXECUTIONS_MODE, 'queue');
    assert.equal(env.QUEUE_BULL_REDIS_HOST, 'redis');
    assert.equal(env.DB_TYPE, 'postgresdb');
    assert.equal(env.DB_POSTGRESDB_HOST, 'n8n-postgres');
    assert.equal(env.QUEUE_HEALTH_CHECK_ACTIVE, 'true');
  }
});

test('INF-06 workers start in worker mode with configurable concurrency and replicas', () => {
  const worker = services['n8n-worker'];
  assert.equal(worker.command[0], 'worker');
  assert.match(worker.command[1], /--concurrency=\$\{N8N_WORKER_CONCURRENCY:-\d+\}/);
  assert.match(String(worker.deploy.replicas), /\$\{N8N_WORKER_REPLICAS:-\d+\}/);
  assert.equal(worker.ports, undefined, 'workers must not publish ports');
});

test('INF-07 startup order waits for healthy dependencies', () => {
  assert.equal(services.n8n.depends_on['n8n-postgres'].condition, 'service_healthy');
  assert.equal(services.n8n.depends_on.redis.condition, 'service_healthy');
  assert.equal(services['n8n-worker'].depends_on.n8n.condition, 'service_healthy');
});

test('INF-08 Redis requires a password, persists data and never evicts queued jobs', () => {
  const cmd = services.redis.command.join(' ');
  assert.match(cmd, /--requirepass \$\{REDIS_PASSWORD:\?/);
  assert.match(cmd, /--appendonly yes/);
  assert.match(cmd, /--maxmemory-policy noeviction/);
});

test('INF-09 required secrets fail fast when missing and are never hard-coded', () => {
  for (const key of ['N8N_DB_PASSWORD', 'REDIS_PASSWORD', 'N8N_ENCRYPTION_KEY', 'PLATFORM_HMAC_SECRET', 'AGENT_DATABASE_URL']) {
    assert.match(composeText, new RegExp(`\\$\\{${key}:\\?`), `${key} must use the required-variable syntax`);
  }
  const literalSecret = /^\s*[A-Z0-9_]*(PASSWORD|SECRET|ENCRYPTION_KEY|ROLE_KEY):\s*(?!\$\{)\S+/m;
  assert.doesNotMatch(composeText, literalSecret);
});

test('INF-10 only the main instance publishes a port, bound to localhost', () => {
  for (const [name, svc] of Object.entries(services)) {
    if (name === 'n8n') {
      assert.equal(svc.ports.length, 1);
      assert.match(svc.ports[0], /^127\.0\.0\.1:/);
    } else {
      assert.equal(svc.ports, undefined, `${name} must not publish ports`);
    }
  }
});

test('INF-11 data survives restarts through named volumes', () => {
  assert.deepEqual(Object.keys(compose.volumes).sort(), ['n8n_data', 'n8n_postgres_data', 'redis_data']);
  assert.ok(services['n8n-postgres'].volumes.some((v) => v.startsWith('n8n_postgres_data:')));
  assert.ok(services.redis.volumes.some((v) => v.startsWith('redis_data:')));
  assert.ok(services.n8n.volumes.some((v) => v.startsWith('n8n_data:')));
});

test('INF-12 every variable used by the stack is documented in .env.example', () => {
  const used = new Set([...composeText.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]));
  const documented = new Set([...envExample.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
  const missing = [...used].filter((v) => !documented.has(v));
  assert.deepEqual(missing, []);
});

test('INF-13 .env.example ships placeholders only', () => {
  for (const key of ['N8N_DB_PASSWORD', 'REDIS_PASSWORD', 'N8N_ENCRYPTION_KEY', 'PLATFORM_HMAC_SECRET', 'AGENT_DATABASE_URL']) {
    assert.match(envExample, new RegExp(`^${key}=change-me$`, 'm'));
  }
  assert.match(envExample, /^SUPABASE_SERVICE_ROLE_KEY=$/m);
});

test('INF-14 execution history is pruned and logs are structured JSON', () => {
  const env = services.n8n.environment;
  assert.equal(env.EXECUTIONS_DATA_PRUNE, 'true');
  assert.equal(env.N8N_LOG_FORMAT, 'json');
});

const workflow = JSON.parse(readFileSync(new URL('infra/n8n/workflows/agent-scheduler.json', root), 'utf8'));
const dockerfile = readFileSync(new URL('agents/Dockerfile', root), 'utf8');

test('INF-15 the agent service is built from /agents, stays internal and can scale', () => {
  const svc = services['agent-service'];
  assert.equal(svc.build, '../agents');
  assert.equal(svc.ports, undefined);
  assert.match(String(svc.deploy.replicas), /\$\{AGENT_SERVICE_REPLICAS:-\d+\}/);
  assert.deepEqual(svc.networks, ['internal']);
  assert.match(svc.healthcheck.test.join(' '), /127\.0\.0\.1:8080\/health/);
});

test('INF-16 the agent service shares the signing secret with n8n and n8n knows where it is', () => {
  assert.equal(services['agent-service'].environment.PLATFORM_HMAC_SECRET, services.n8n.environment.PLATFORM_HMAC_SECRET);
  for (const name of ['n8n', 'n8n-worker']) {
    assert.equal(services[name].environment.AGENT_SERVICE_URL, 'http://agent-service:8080');
    assert.equal(services[name].environment.NODE_FUNCTION_ALLOW_BUILTIN, 'crypto');
  }
});

test('INF-17 the agent image is pinned, runs as a non-root user and has no build step', () => {
  assert.match(dockerfile, /^FROM node:\d+\.\d+\.\d+-alpine$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /CMD \["node", "src\/main\.ts"\]/);
});

test('INF-18 the scheduler workflow signs a run request every minute', () => {
  const byType = (t) => workflow.nodes.filter((n) => n.type === t);
  const schedule = byType('n8n-nodes-base.scheduleTrigger')[0];
  assert.deepEqual(schedule.parameters.rule.interval[0], { field: 'minutes', minutesInterval: 1 });
  const code = byType('n8n-nodes-base.code')[0].parameters.jsCode;
  assert.match(code, /require\('crypto'\)/);
  assert.match(code, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  assert.match(code, /`\$\{timestamp\}\.\$\{body\}`/);
  const http = byType('n8n-nodes-base.httpRequest')[0].parameters;
  assert.equal(http.method, 'POST');
  assert.match(http.url, /\$env\.AGENT_SERVICE_URL.*\/jobs\/run/);
  const headers = http.headerParameters.parameters.map((p) => p.name).sort();
  assert.deepEqual(headers, ['content-type', 'x-signature', 'x-timestamp']);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.deepEqual(Object.keys(workflow.connections).sort(), ['Every minute', 'Sign request']);
});

test('INF-19 workflows are imported by a one-shot job before n8n starts', () => {
  const job = services['n8n-import'];
  assert.equal(job.image, services.n8n.image);
  assert.equal(job.restart, 'no');
  assert.deepEqual(job.entrypoint, ['node', '/import/import-workflows.mjs']);
  assert.ok(job.volumes.includes('./n8n/workflows:/workflows:ro'));
  assert.ok(job.volumes.includes('./n8n/import-workflows.mjs:/import/import-workflows.mjs:ro'));
  assert.equal(job.environment.DB_POSTGRESDB_HOST, 'n8n-postgres');
  assert.equal(job.environment.N8N_ENCRYPTION_KEY, services.n8n.environment.N8N_ENCRYPTION_KEY);
  assert.equal(job.depends_on['n8n-postgres'].condition, 'service_healthy');
  assert.equal(services.n8n.depends_on['n8n-import'].condition, 'service_completed_successfully');
  assert.equal(job.ports, undefined);
});

test('INF-20 every workflow in the repository is valid for import, with a fixed unique id', () => {
  const { workflows, commands } = planImport(new URL('infra/n8n/workflows', root).pathname);
  assert.ok(workflows.length >= 1);
  assert.equal(new Set(workflows.map((w) => w.id)).size, workflows.length);
  assert.deepEqual(commands[0], ['import:workflow', '--separate', `--input=${new URL('infra/n8n/workflows', root).pathname}`]);
  assert.ok(commands.some((c) => c[0] === 'publish:workflow' && c[1] === '--id=aisdrAgentSched1'));
});

test('INF-21 the importer rejects bad files and publishes only active workflows', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'wf-'));
  const wf = (over) => JSON.stringify({ id: 'abcdefghij123456', name: 'A', nodes: [{}], active: false, ...over });
  const d1 = dir();
  writeFileSync(join(d1, 'a.json'), wf({ id: 'abcdefghij123456', active: true }));
  writeFileSync(join(d1, 'b.json'), wf({ id: 'bbcdefghij123456' }));
  writeFileSync(join(d1, 'notes.txt'), 'ignored');
  assert.deepEqual(planImport(d1).commands.slice(1), [['publish:workflow', '--id=abcdefghij123456']]);
  const d2 = dir();
  writeFileSync(join(d2, 'a.json'), wf({}));
  writeFileSync(join(d2, 'b.json'), wf({}));
  assert.throws(() => planImport(d2), /used by another workflow/);
  for (const [over, msg] of [[{ id: 'short' }, /16 letters/], [{ name: '' }, /name/], [{ nodes: [] }, /nodes/], [{ active: 'yes' }, /active/]]) {
    const d = dir();
    writeFileSync(join(d, 'x.json'), wf(over));
    assert.throws(() => planImport(d), msg);
  }
  assert.deepEqual(planImport(dir()).commands, []);
});

test('INF-22 the Instantly events workflow receives per-workspace webhooks and forwards them signed', () => {
  const wf = JSON.parse(readFileSync(new URL('infra/n8n/workflows/instantly-events.json', root), 'utf8'));
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters;
  assert.equal(hook.httpMethod, 'POST');
  assert.equal(hook.path, 'instantly/:token');
  assert.equal(hook.responseMode, 'onReceived');
  const code = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
  assert.match(code, /item\.json\.params\?\.token/);
  assert.match(code, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  const http = wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').parameters;
  assert.match(http.url, /\$env\.AGENT_SERVICE_URL.*\/webhooks\/instantly/);
  assert.equal(wf.active, true);
  assert.equal(wf.settings.saveDataSuccessExecution, 'none');
});

test('INF-23 the Calendly events workflow forwards the raw signed body and Calendly signature', () => {
  const wf = JSON.parse(readFileSync(new URL('infra/n8n/workflows/calendly-events.json', root), 'utf8'));
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters;
  assert.equal(hook.path, 'calendly/:token');
  assert.equal(hook.options.rawBody, true);
  const code = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
  assert.match(code, /getBinaryDataBuffer\(i, 'data'\)/);
  assert.match(code, /calendly-webhook-signature/);
  assert.match(code, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  const http = wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').parameters;
  assert.match(http.url, /\/webhooks\/calendly/);
  assert.equal(services['agent-service'].environment.WEBHOOK_BASE_URL, '${N8N_PUBLIC_URL:-}');
});

test('INF-24 the Vapi call events workflow forwards call results signed', () => {
  const wf = JSON.parse(readFileSync(new URL('infra/n8n/workflows/vapi-events.json', root), 'utf8'));
  assert.equal(wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters.path, 'vapi/:token');
  assert.match(wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  assert.match(wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').parameters.url, /\/webhooks\/vapi/);
  assert.ok(planImport(new URL('infra/n8n/workflows', root).pathname).workflows.some((w) => w.id === 'aisdrVapiEvents1'));
});

test('INF-25 the Twilio text events workflow forwards the signed form body and answers with empty TwiML', () => {
  const wf = JSON.parse(readFileSync(new URL('infra/n8n/workflows/twilio-events.json', root), 'utf8'));
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters;
  assert.equal(hook.path, 'twilio/:token');
  assert.equal(hook.options.rawBody, true);
  assert.equal(hook.options.responseContentType, 'text/xml');
  assert.match(hook.options.responseData, /<Response><\/Response>/);
  const code = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
  assert.match(code, /getBinaryDataBuffer\(i, 'data'\)/);
  assert.match(code, /x-twilio-signature/);
  assert.match(code, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  assert.match(wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').parameters.url, /\/webhooks\/twilio/);
  assert.ok(planImport(new URL('infra/n8n/workflows', root).pathname).workflows.some((w) => w.id === 'aisdrTwilioEvnt1'));
});

test('INF-26 the Stripe payment events workflow forwards the raw signed body and Stripe-Signature', () => {
  const wf = JSON.parse(readFileSync(new URL('infra/n8n/workflows/stripe-events.json', root), 'utf8'));
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook').parameters;
  assert.equal(hook.path, 'stripe/:token');
  assert.equal(hook.options.rawBody, true);
  const code = wf.nodes.find((n) => n.type === 'n8n-nodes-base.code').parameters.jsCode;
  assert.match(code, /getBinaryDataBuffer\(i, 'data'\)/);
  assert.match(code, /stripe-signature/);
  assert.match(code, /createHmac\('sha256', \$env\.PLATFORM_HMAC_SECRET\)/);
  assert.match(wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest').parameters.url, /\/webhooks\/stripe/);
  const ids = planImport(new URL('infra/n8n/workflows', root).pathname).workflows.map((w) => w.id);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
});
