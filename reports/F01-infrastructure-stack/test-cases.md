# F01 — Infrastructure Stack: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| | |
| --- | --- |
| Test suite | `tests/infra/compose.test.mjs` |
| Command | `npm run test:infra` |
| Result | **14 passed, 0 failed** |
| Compose validation | `docker compose config --quiet` passed (Docker Compose v5.7.0) |
| Environment | Node.js 22 |

## Automated configuration tests

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-01 | Stack defines database, queue, main instance and workers | Exactly `n8n`, `n8n-worker`, `redis`, `n8n-postgres` | Pass |
| INF-02 | Every image is pinned to an exact version | No `latest` tag, every image has a version | Pass |
| INF-03 | Main instance and workers run the same n8n version | Identical image for both | Pass |
| INF-04 | Every service has a health check and a restart policy | Health check present, `restart: unless-stopped` | Pass |
| INF-05 | n8n runs in queue mode on Redis with PostgreSQL | `EXECUTIONS_MODE=queue`, Redis host, PostgreSQL host, queue health check on | Pass |
| INF-06 | Workers start in worker mode with configurable concurrency and replicas | `worker --concurrency=…`, replicas from environment, no published port | Pass |
| INF-07 | Start-up order waits for healthy dependencies | n8n waits for PostgreSQL and Redis; workers wait for n8n | Pass |
| INF-08 | Redis requires a password, persists data and never evicts jobs | `--requirepass`, `--appendonly yes`, `--maxmemory-policy noeviction` | Pass |
| INF-09 | Required secrets fail fast and are never hard-coded | Four secrets use `${VAR:?}`; no literal secret in the file | Pass |
| INF-10 | Only the main instance publishes a port, bound to localhost | One port, `127.0.0.1` only | Pass |
| INF-11 | Data survives restarts through named volumes | Three named volumes mounted by the right services | Pass |
| INF-12 | Every variable used by the stack is documented | No variable missing from `.env.example` | Pass |
| INF-13 | `.env.example` ships placeholders only | Secrets are `change-me`; service key is empty | Pass |
| INF-14 | Execution history is pruned and logs are structured JSON | Pruning on, `N8N_LOG_FORMAT=json` | Pass |

## Deployment verification checklist

Run on the Docker host after each deployment.

| ID | Check | Command | Expected result |
| --- | --- | --- | --- |
| RUN-01 | Stack starts | `npm run infra:up` | All containers created |
| RUN-02 | All services healthy | `npm run infra:ps` | `n8n`, `redis`, `n8n-postgres` and both workers show `healthy` |
| RUN-03 | Main instance answers | `curl -s http://localhost:5678/healthz` | `{"status":"ok"}` |
| RUN-04 | Workers joined the queue | `docker compose -f infra/docker-compose.yml --env-file infra/.env logs n8n-worker` | Each worker logs that it is ready |
| RUN-05 | Queue rejects unauthenticated access | `docker compose -f infra/docker-compose.yml --env-file infra/.env exec -e REDISCLI_AUTH= redis redis-cli ping` | `NOAUTH Authentication required` |
| RUN-06 | Missing secret blocks start-up | Remove `REDIS_PASSWORD` from `infra/.env`, run `npm run infra:up` | Error names `REDIS_PASSWORD`; nothing starts |
| RUN-07 | Scaling works | `npm run infra:scale` then `npm run infra:ps` | Four healthy workers |
| RUN-08 | Data survives restart | Create a workflow, `npm run infra:down`, `npm run infra:up` | Workflow is still present |
