# F29 — Public API and Outbound Webhooks: Use Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

## Actors

| Actor | Description |
| --- | --- |
| Owner, Admin | Create keys and endpoints |
| A caller | Zapier, Make, n8n or the team's own code, holding a key |
| A receiver | The team's server or automation tool receiving webhooks |
| Agent service | Sends deliveries |

## UC-F29-01 A website form adds leads

| | |
| --- | --- |
| Actor | Admin, then the website |
| Main flow | 1. API, create a key named "Website form" with "Add leads". 2. Copies it once. 3. The form's backend posts each submission to `/api/v1/leads`. |
| Result | Each new person is a lead with source `api`. A repeat submission returns the existing lead. A suppressed address is reported, not added |

## UC-F29-02 Nightly sync to a data warehouse

| | |
| --- | --- |
| Main flow | A job reads `GET /leads?updated_after=<last run>` page by page with `next_cursor` |
| Result | Every changed lead, oldest change first, without missing or repeating one |

## UC-F29-03 Tell the team's Slack workflow when a deal is won

| | |
| --- | --- |
| Main flow | 1. API, add `https://hooks.zapier.com/...` with "A deal is won". 2. Send a test event. |
| Result | The test shows "Delivered". From then on, each won deal reaches Zapier within a minute, signed |

## UC-F29-04 The receiver checks the signature

| | |
| --- | --- |
| Main flow | The receiver recomputes the HMAC of `<t>.<body>` with the secret, and rejects anything older than five minutes |
| Result | A forged or replayed request is rejected |

## UC-F29-05 The receiver is down

| | |
| --- | --- |
| Result | Retries after 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours. Each attempt shows on the API page. After 15 failures in a row the endpoint is switched off and the team is alerted once |

## UC-F29-06 A key leaks

| | |
| --- | --- |
| Actor | Owner |
| Main flow | Revokes it on the API page |
| Result | The next request with it answers 401 |

## UC-F29-07 A key tries more than it may

| | |
| --- | --- |
| Result | A read-only key adding a lead gets 403 "This key does not have the leads:write scope"; a busy script gets 429 after 120 requests in a minute |

## UC-F29-08 Someone points a webhook at an internal address

| | |
| --- | --- |
| Result | `http://`, other ports and IP literals are refused when saved. A name that resolves to a private address is refused before each attempt, and no request is made |

## UC-F29-09 A caller tries to reopen an opted-out lead

| | |
| --- | --- |
| Result | 422: "This lead asked not to be contacted; change it in the app if that is right" |
