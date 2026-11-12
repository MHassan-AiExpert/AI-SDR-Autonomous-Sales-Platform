# F01 — Infrastructure Stack: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Platform engineer | Deploys, scales and maintains the platform |
| n8n main instance | Receives webhooks and schedules and enqueues jobs |
| n8n worker | Executes queued jobs |
| External service | Twilio, Vapi, Instantly, WhatsApp, Zoom or Stripe sending a webhook |

## UC-F01-01 Start the platform stack

| | |
| --- | --- |
| Actor | Platform engineer |
| Precondition | Docker is installed; `infra/.env` exists with all required secrets |
| Trigger | `npm run infra:up` |
| Main flow | 1. PostgreSQL and Redis start and report healthy. 2. The n8n main instance starts and reports healthy. 3. Two workers start and connect to the queue. |
| Result | The editor answers on `http://localhost:5678` and workers wait for jobs |
| Alternative | A required secret is missing: Compose stops with the name of the missing variable and starts nothing |

## UC-F01-02 Many subscribers run work at the same time

| | |
| --- | --- |
| Actor | n8n main instance, n8n workers |
| Precondition | Stack is running |
| Trigger | Schedules and webhooks for several workspaces fire at once |
| Main flow | 1. The main instance places one job per event in Redis. 2. Each free worker takes the next job, whichever workspace it belongs to. 3. Each worker runs up to 10 jobs concurrently. |
| Result | Jobs for different subscribers run in parallel; none waits for another subscriber's job to finish |

## UC-F01-03 Scale throughput

| | |
| --- | --- |
| Actor | Platform engineer |
| Trigger | Queue latency grows as subscribers are added |
| Main flow | 1. Run `npm run infra:scale` or set `N8N_WORKER_REPLICAS`. 2. New workers start and join the same queue. |
| Result | More jobs run at once; no workflow, subscriber or database change is needed |

## UC-F01-04 Recover from a worker crash

| | |
| --- | --- |
| Actor | n8n worker |
| Trigger | A worker process exits or becomes unhealthy |
| Main flow | 1. Docker restarts the container. 2. Jobs that were not finished stay in Redis and are picked up again. 3. Other workers keep processing meanwhile. |
| Result | No job is lost; subscribers on other workers are unaffected |

## UC-F01-05 Restart without losing data

| | |
| --- | --- |
| Actor | Platform engineer |
| Trigger | Server reboot or `npm run infra:down` followed by `npm run infra:up` |
| Main flow | 1. Containers stop. 2. Workflows, execution history and queued jobs stay in named volumes. 3. The stack starts in dependency order. |
| Result | Workflows and pending jobs are intact |

## UC-F01-06 Receive a webhook from an external service

| | |
| --- | --- |
| Actor | External service |
| Precondition | A TLS reverse proxy forwards the public URL to `127.0.0.1:5678` |
| Trigger | A call ends, a reply arrives or a payment succeeds |
| Main flow | 1. The service posts to the webhook URL. 2. The main instance accepts it and enqueues a job. 3. A worker processes it. |
| Result | The event is handled asynchronously; the sender gets a fast response |

## UC-F01-07 Roll back an n8n upgrade

| | |
| --- | --- |
| Actor | Platform engineer |
| Trigger | A new n8n version misbehaves |
| Main flow | 1. Restore the previous image tag in `docker-compose.yml`. 2. Run `npm run infra:up`. |
| Result | Main instance and workers return to the previous version together |

## UC-F01-08 Rotate a secret

| | |
| --- | --- |
| Actor | Platform engineer |
| Trigger | Scheduled rotation or suspected exposure of the Redis or database password, or the HMAC secret |
| Main flow | 1. Update the value in `infra/.env`. 2. Recreate the stack. |
| Result | All services use the new secret |
| Rule | `N8N_ENCRYPTION_KEY` is never rotated this way, because it decrypts stored credentials |
