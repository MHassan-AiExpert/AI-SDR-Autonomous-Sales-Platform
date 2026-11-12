# F02 — Multi-Tenant Database: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| | |
| --- | --- |
| Test suites | `tests/db/tenancy.test.mjs`, `tests/db/sales-data.test.mjs` |
| Command | `npm run test:db` |
| Result | **43 passed, 0 failed** |
| Live database | Schema applied to the hosted Supabase project (PostgreSQL 17); 4 live checks passed |
| Method | The real migration files are applied to an in-process PostgreSQL. Each test runs as a specific signed-in user, an anonymous visitor or the backend service role. |

## Test data

| Workspace | Members |
| --- | --- |
| Company A | Owner A, Admin A, Rep A, Viewer A |
| Company B | Owner B |
| None | Outsider (signed in, member of nothing), anonymous visitor |

## Structure

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-01 | Migrations apply cleanly in order | All three migrations run without error | Pass |
| DB-02 | Every public table has row-level security enabled | No table without RLS | Pass |
| DB-03 | Every tenant table carries a mandatory `workspace_id` | All 18 tenant tables have a non-null `workspace_id` | Pass |
| DB-04 | Every table has at least one policy | No table without a policy | Pass |
| DB-43 | Every function in the `app` schema pins its `search_path` | No function with a mutable search path | Pass |

## Workspaces

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-05 | Creator of a workspace becomes its owner | Membership row with role `owner` | Pass |
| DB-06 | New workspaces default to full autopilot | Autopilot, not paused, AI closer on, email/voice/SMS/WhatsApp on | Pass |
| DB-07 | User creates a workspace on behalf of someone else | Rejected by RLS | Pass |

## Tenant isolation

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-08 | User lists workspaces | Only their own; outsider sees none | Pass |
| DB-09 | Owner B reads leads, including Company A's lead by ID | Only Company B's lead; lookup by ID returns nothing | Pass |
| DB-10 | Owner B inserts a lead into Company A | Rejected by RLS | Pass |
| DB-11 | Owner B updates and deletes Company A's lead | Zero rows affected; lead unchanged | Pass |
| DB-12 | Owner B moves their own lead into Company A | Rejected by RLS | Pass |
| DB-13 | Owner B lists members | Only Company B's member | Pass |
| DB-14 | Anonymous visitor reads workspaces, leads, deals, suppressions | Permission denied on each | Pass |
| DB-15 | Service role links a Company A lead to a Company B campaign, and a Company A activity to a Company B lead | Rejected by foreign key | Pass |

## Roles

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-16 | Viewer reads, inserts and updates a lead | Read works; insert rejected; update affects zero rows | Pass |
| DB-17 | Rep updates a lead, creates a campaign, integration and playbook, deletes a lead | Update works; configuration writes rejected; delete affects zero rows | Pass |
| DB-18 | Admin creates a campaign and integration and changes automation mode | All succeed | Pass |
| DB-19 | Rep turns on the kill switch | Zero rows affected | Pass |
| DB-20 | Admin grants owner, promotes a rep to admin, demotes the owner | All blocked | Pass |
| DB-21 | Rep adds a member and promotes themselves | Insert rejected; update affects zero rows | Pass |
| DB-22 | Last owner demotes or removes themselves | Rejected: a workspace must keep at least one owner | Pass |

## Audit and logs

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-23 | Owner pauses outreach, switches off SMS, changes a role | Audit rows for each action with the actor's ID | Pass |
| DB-24 | Rep and Owner B read the audit log; Owner A inserts and deletes audit rows | No rows visible; insert and delete denied | Pass |
| DB-25 | Owner writes a run log; service role writes one; owner and rep read | Owner write denied; service write works; owner sees it; rep does not | Pass |

## Leads

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-26 | Same email in different letter case added twice in one company | Rejected as duplicate | Pass |
| DB-27 | Same email added in two companies | Accepted | Pass |
| DB-28 | Lead with no email, phone, LinkedIn or social handle; lead with only an Instagram handle | First rejected; second accepted | Pass |
| DB-29 | Score 101, score -1, unknown stage, unknown source channel | Each rejected | Pass |
| DB-30 | One lead from each of the 12 source channels | All accepted and counted by channel | Pass |
| DB-31 | Update a lead's title, then its stage | Stage timestamp unchanged by the title, refreshed by the stage | Pass |
| DB-32 | Delete a campaign that has leads | Leads kept with no campaign | Pass |

## Timeline and sends

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-33 | Store an email, call, WhatsApp message, reply, meeting, audit, proposal, follow-up and five timeline entries for one lead | Viewer reads five timeline entries in order; Company B sees none | Pass |
| DB-34 | Insert an email, call and message again with the same idempotency key | Each rejected as duplicate | Pass |
| DB-35 | Unknown call agent, unknown outcome, unknown reply class, confidence 1.5; receptionist and closer calls | Invalid values rejected; valid agents accepted | Pass |

## Deals

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-36 | Open a deal, mark it won with signed agreement and payment; open a second deal; set an unknown stage | Deal stored as won by AI with its value; second deal and unknown stage rejected | Pass |

## Suppression

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-37 | Check a suppressed email (different case), an address on a suppressed domain, a suppressed phone, a clean contact, the same values in Company B, and Company B probing Company A's list | True, true, true, false, false, false | Pass |
| DB-38 | Add a mixed-case entry; add an existing entry again | Both rejected | Pass |

## Configuration

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-39 | Activate a second playbook while one is live; then switch versions | First attempt rejected; after the switch only version 2 is live | Pass |
| DB-40 | Connect Twilio twice in one company; connect it in another company; inspect columns | Second rejected; other company accepted; only a secret reference column exists | Pass |

## Lifecycle

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DB-41 | Update a lead | `updated_at` refreshed | Pass |
| DB-42 | Owner deletes Company A's workspace | All Company A rows removed from 12 tables; Company B's rows unchanged | Pass |

## Live database verification

Run against the hosted Supabase project after the migrations were applied.

| ID | Check | Expected result | Actual |
| --- | --- | --- | --- |
| LIVE-01 | Compare the live schema with the repository migrations: 225 columns, 74 policies, 121 constraints, 55 indexes, 9 functions, 14 triggers, by checksum | Identical checksums in every category | Pass |
| LIVE-02 | Tables without RLS; table privileges held by anonymous visitors; write privileges on audit and run logs for signed-in users | Zero in each | Pass |
| LIVE-03 | Supabase security advisor | No findings | Pass |
| LIVE-04 | Smoke test inside a rolled-back transaction: user A creates a workspace and a lead; user B reads leads and workspaces, inserts into and updates workspace A | A is owner and sees 1 lead; B sees 0 leads and 0 workspaces; insert blocked; update affects 0 rows; membership audited | Pass |
