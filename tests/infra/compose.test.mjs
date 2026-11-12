import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const root = new URL('../../', import.meta.url);
const composeText = readFileSync(new URL('infra/docker-compose.yml', root), 'utf8');
const compose = parse(composeText, { merge: true });
const envExample = readFileSync(new URL('infra/.env.example', root), 'utf8');
const services = compose.services;

test('INF-01 stack defines database, queue, main instance and workers', () => {
  assert.deepEqual(Object.keys(services).sort(), ['n8n', 'n8n-postgres', 'n8n-worker', 'redis']);
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

test('INF-04 every service has a health check and a restart policy', () => {
  for (const [name, svc] of Object.entries(services)) {
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
  for (const key of ['N8N_DB_PASSWORD', 'REDIS_PASSWORD', 'N8N_ENCRYPTION_KEY', 'PLATFORM_HMAC_SECRET']) {
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
  for (const key of ['N8N_DB_PASSWORD', 'REDIS_PASSWORD', 'N8N_ENCRYPTION_KEY', 'PLATFORM_HMAC_SECRET']) {
    assert.match(envExample, new RegExp(`^${key}=change-me$`, 'm'));
  }
  assert.match(envExample, /^SUPABASE_SERVICE_ROLE_KEY=$/m);
});

test('INF-14 execution history is pruned and logs are structured JSON', () => {
  const env = services.n8n.environment;
  assert.equal(env.EXECUTIONS_DATA_PRUNE, 'true');
  assert.equal(env.N8N_LOG_FORMAT, 'json');
});
