# AI SDR Platform — API and Webhooks

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

The platform exposes a REST API for reading and adding leads, and sends signed webhooks when something happens in a workspace. Both are managed by owners and admins on the **API** page of a workspace.

## Authentication

Create a key on the API page and choose its permissions. The key is shown once; only a SHA-256 hash of it is stored.

```
Authorization: Bearer sdr_<64 hex characters>
```

| Permission | Allows |
| --- | --- |
| `leads:read` | `GET /leads`, `GET /leads/{id}` |
| `leads:write` | `POST /leads`, `PATCH /leads/{id}` |
| `deals:read` | `GET /deals` |
| `campaigns:read` | `GET /campaigns` |
| `meetings:read` | `GET /meetings` |

A key only ever sees its own workspace. Revoking a key takes effect immediately.

## Limits

- 120 requests a minute per key; the 121st answers `429`.
- Request bodies are JSON objects of at most 16 KB.
- Lists return up to 100 items per page (50 by default).

## Base URL

```
https://<your app domain>/api/v1
```

## Endpoints

### `GET /leads`

| Query parameter | Meaning |
| --- | --- |
| `stage` | `new`, `contacted`, `engaged`, `interested`, `meeting_booked`, `won`, `lost`, `not_interested` or `do_not_contact` |
| `campaign_id` | Only this campaign's leads |
| `updated_after` | ISO 8601 date and time |
| `limit` | 1 to 100 |
| `cursor` | `next_cursor` from the previous page |

```json
{
  "data": [{
    "id": "…", "email": "kim@bright.test", "full_name": "Kim Lee", "phone": "+15125550100", "title": "Owner",
    "linkedin_url": null, "stage": "interested", "score": 82, "campaign_id": "…", "source": "apollo",
    "company": { "id": "…", "name": "Bright Dental", "domain": "bright.test" },
    "created_at": "2026-11-17T09:00:00+00:00", "updated_at": "2026-11-17T10:12:44+00:00"
  }],
  "next_cursor": "2026-11-17T10:12:44+00:00|…"
}
```

Leads come back oldest change first, so a sync job can store `next_cursor` (or the last `updated_at`) and continue from there.

### `GET /leads/{id}`

One lead, as above, under `data`. `404` when it is not in the key's workspace.

### `POST /leads`

```json
{ "email": "kim@bright.test", "full_name": "Kim Lee", "phone": "+1 512 555 0100", "title": "Owner",
  "company": "Bright Dental", "domain": "bright.test", "campaign_id": "…", "linkedin_url": "https://www.linkedin.com/in/…" }
```

At least one of `email`, `phone` or `linkedin_url` is required. The same hygiene as a CSV import applies:

| Answer | When |
| --- | --- |
| `201` `{"created": true, "data": {…}}` | Added, with source `api` |
| `200` `{"created": false, "reason": "duplicate", "data": {…}}` | A lead with this email already exists; it is returned |
| `200` `{"created": false, "reason": "suppressed"}` | The email, phone or domain is on the suppression list |
| `422` | A field is not valid; the message says which |

### `PATCH /leads/{id}`

```json
{ "stage": "won" }
```

The change is recorded in the lead's history with the key's name. Setting `do_not_contact` also adds the email to the suppression list, and a lead that asked not to be contacted cannot be reopened through the API.

### `GET /deals`

Parameters `stage`, `updated_after`, `limit`, `cursor`. Each deal has `id`, `lead_id`, `campaign_id`, `stage`, `value_cents`, `currency`, `plan_name`, `closed_at`, `created_at` and `updated_at`.

### `GET /campaigns`

Every campaign that is not archived: `id`, `name`, `status`, `niche`, `created_at`.

### `GET /meetings`

Parameters `starts_after`, `limit`, `cursor`. Each meeting has `id`, `lead_id`, `starts_at`, `status`, `booked_via`, `run_by` and `created_at`.

## Errors

```json
{ "error": "This key does not have the leads:write scope" }
```

| Status | Meaning |
| --- | --- |
| `400` | The body is not a JSON object |
| `401` | No key, or an invalid or revoked key |
| `403` | The key lacks the permission |
| `404` | Unknown endpoint, or not found in this workspace |
| `405` | Method not allowed |
| `422` | A field is not valid |
| `429` | Rate limit reached |
| `500` | Something went wrong on our side; nothing internal is revealed |

## Webhooks

Add an endpoint on the API page: an `https` address on the standard port, and the events to send.

| Event | When |
| --- | --- |
| `lead.created` | A lead is added, by any route (sourcing, CSV, API, inbound call) |
| `lead.stage_changed` | A lead's stage changes; `data.previous_stage` is included |
| `reply.received` | A lead replies on any channel |
| `meeting.booked` | A meeting is booked |
| `deal.won`, `deal.lost` | A deal is won or lost |
| `test` | Sent from the API page with "Send a test event" |

Each delivery is a `POST` with this body:

```json
{ "id": "evt-uuid", "type": "deal.won", "created_at": "2026-11-17T10:12:44+00:00", "workspace_id": "…", "data": { … } }
```

and these headers:

| Header | Value |
| --- | --- |
| `X-SDR-Event` | The event type |
| `X-SDR-Delivery` | This delivery's id |
| `X-SDR-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` with the endpoint's signing secret |

The body's `id` is the same for every endpoint and every retry: store it and ignore repeats.

### Verifying a delivery

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '') ?? [];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
```

### Retries

Answer with any `2xx` within 10 seconds. Otherwise the delivery is retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours, then given up. Redirects are not followed. An endpoint that fails 15 times in a row is switched off and the team is alerted; switching it back on resets the count. Delivery history is kept for 30 days.
