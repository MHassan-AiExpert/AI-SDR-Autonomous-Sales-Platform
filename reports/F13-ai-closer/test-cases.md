# F13 — AI Closer: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/closer.test.mjs`) | `npm run test:db` | **5 passed, 0 failed** |
| Infrastructure (`tests/infra/compose.test.mjs`, INF-26) | `npm run test:infra` | **1 passed, 0 failed** |
| Agent service (`agents/tests/closer.test.ts`) | `cd agents && npm test` | **16 passed, 0 failed** |
| Web unit (`web/tests/closer.test.ts`) | `cd web && npm test` | **5 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **16 passed, 0 failed** (Deals and Playbook pages added to E2E-03) |
| Type checks and build | `npm run typecheck` in `agents` and `web`, `npm run build` in `web` | Passed |
| Full regression | root 155, agents 194, web 88 | **437 passed, 0 failed** |

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CL-01 | Closer defaults; invalid meeting phone, closer status, assistant id; invalid payment address, payment link id, proposal address, billing | Pending and none by default; every invalid value rejected | Pass |
| CL-02 | Rep moves a deal, records an offline payment and marks it for the team; admin sets a payment address, a PandaDoc id or the sending status; rep creates a deal with a payment address; the platform sets the links | Allowed; refused; refused; allowed | Pass |
| CL-03 | Second deal with the same payment link; owner reads the Stripe endpoint table; plain-text secret | Rejected; permission denied; rejected | Pass |
| CL-04 | Meetings in 30 minutes, 20 minutes ago, run by the team, closer switched off, starting now (twice); agreed deal waiting; kill switch | No run, no run, no run, no run, one run; one run; not claimed while paused | Pass |
| CL-05 | Admin then owner publish playbooks; rep publishes; invalid content | Versions 1 then 2, only the latest live; refused; refused | Pass |

## Infrastructure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| INF-26 | Stripe payment events workflow | Webhook at `stripe/:token` with the raw body, forwards Stripe-Signature signed to `/webhooks/stripe`; six workflows with unique ids | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CC-01 | Plan matching by exact name, partial name, unknown, empty, single plan; prices; invalid playbooks | Price always from the playbook; unknown plans not matched; invalid playbooks rejected | Pass |
| CC-02 | Number given for the meeting; consented checked number; checked number without consent; suppressed | Called; called; team; team | Pass |
| CC-03 | "Don't call me again" with an agreed analysis; voicemail; no answer; agreed; unclear; empty | Do not call; voicemail; no answer; agreed; needs a person; no answer | Pass |
| CC-04 | Opening line, prompt and proposal fields | AI disclosure; exact prices; no discounts; no card details; playbook and research wrapped as data; plan names only; fields filled | Pass |
| CC-05 | Stripe form encoding, webhook signatures, payment link requests and errors | Correct encoding; only genuine recent signatures pass; price and link with idempotency keys; Stripe's error text never passed on | Pass |
| CC-06 | PandaDoc document, preparing, sending; meeting phone formats | Template and tokens; waits until draft, then sends; API-Key header; numbers normalised, local numbers rejected | Pass |
| CJ-01 | Meeting with a number, without a number, 12 minutes late | Only the first called, with the closer assistant, AI opening, prices and plan list; the others go to the team with reasons, tasks and Slack | Pass |
| CJ-02 | Run again | No second call | Pass |
| CJ-03 | Report: agreed to "growth" | Meeting completed with summary and recording; deal at Meeting held with Growth at 49900 USD per month; closer run queued | Pass |
| CJ-04 | Closer run for the agreed deal | Stripe endpoint created once, price and payment link created; PandaDoc proposal with the template, recipient and payment link sent; deal Proposal sent, link sent, agreement sent, PandaDoc link | Pass |
| CJ-05 | Stripe payment with a bad signature, valid, repeated, unknown link | 401; won; duplicate; ignored; deal Won, paid, closed by the AI; lead Won | Pass |
| CJ-06 | PandaDoc failing three times | Pending, pending, failed; one payment link only; task for the team | Pass |
| CJ-07 | "Please don't call me again" while the analysis says agreed | Lead Do not contact; deal Lost; number suppressed | Pass |
| CJ-08 | Asked for a discount; agreed without a plan | Both go to the team; call marked handed off | Pass |
| CJ-09 | AI closer switched off | No call; meeting goes to the team with the reason | Pass |
| CJ-10 | All stored deals, events, job results and timeline entries | No Stripe key, PandaDoc key, signing secret, webhook token or Vapi key | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| CW-01 | Playbook form | Plans in cents with currency and billing; questions; objections split at "\|"; default signer role | Pass |
| CW-02 | Bad price, currency, no plans, short offer, bad template id | One clear message each | Pass |
| CW-03 | Closer checklist | Required and optional items; PandaDoc counts only with a template | Pass |
| CW-04 | Payment and proposal links | Only Stripe and PandaDoc https links shown | Pass |
| CW-05 | Labels and closer run results | All present; readable lines | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-27 | Job type and provider extended; 5 meeting and 11 deal columns; deal guard; Stripe endpoint table private; publish function is security invoker; claim holds the closer; closer scheduling | Pass |
| LIVE-28 | Security advisor | No new findings | Pass |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-52 | Write the playbook; set the closer assistant; book a meeting yourself with "we call you" and your own number | At the meeting time your phone rings; the closer says it is an AI assistant and quotes your plans |
| ACC-53 | Agree to a plan on the call | Within a minute, a Stripe test-mode payment link and a PandaDoc proposal carrying it arrive by email |
| ACC-54 | Pay with Stripe test card 4242 4242 4242 4242 on the link | The deal shows Won and Paid; Slack ":tada: Deal won" |
| ACC-55 | Ask for a discount on a second test meeting | Deal Needs your team; task; Slack alert |
