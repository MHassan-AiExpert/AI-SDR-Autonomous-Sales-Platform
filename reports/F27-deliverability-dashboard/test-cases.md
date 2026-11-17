# F27 — Deliverability Dashboard: Test Cases

Engineered by Muhammad Hassan | AI ENGINEER | AUTOMATION SPECIALIST | SOFTWARE ENGINEER | FULL STACK DEVELOPER

| Suite | Command | Result |
| --- | --- | --- |
| Database (`tests/db/deliverability.test.mjs`) | `npm test` | **7 passed, 0 failed** |
| Agent (`agents/tests/deliverability.test.ts`) | `cd agents && npm test` | **22 passed, 0 failed** |
| Web unit (`web/tests/deliverability.test.ts`) | `cd web && npm test` | **8 passed, 0 failed** |
| Browser (`web/e2e/signed-out.e2e.mjs`) | `node e2e/signed-out.e2e.mjs` | **18 passed, 0 failed**; E2E-03 now also covers Deliverability, Signals, Templates and the sequence screen |
| Type checks and build | `npx tsc --noEmit` in `agents` and `web`, `npm run build` | Passed |
| Full regression | root 258, agents 353, web 175 | **786 passed, 0 failed** |

All DNS in the agent tests is answered by a fake resolver from a table; no test touches the network.

## Database

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DLB-01 | Viewer, rep and owner read; another workspace reads | Each sees only their own domains and mailboxes | Pass |
| DLB-02 | Owner sets the DKIM selector; rep, viewer and another owner try; owner edits the score, inserts and deletes | Owner's selector saved; the others change nothing; the rest refused | Pass |
| DLB-03 | A selector with spaces, an upper-case or malformed domain, a duplicate, an upper-case address, an unknown status, score 101, issues as an object | All refused | Pass |
| DLB-04 | Counts with mixed-case addresses, an opened event, an unattributed send, another workspace's send; read by viewer and rep; another workspace asked for | Per-mailbox counts for members, raw events still hidden from them; nothing for the other workspace | Pass |
| DLB-05 | A visitor reads both tables and calls the counts | All refused | Pass |
| DLB-06 | Viewer, then owner, asks for a check now | The viewer changes nothing; the owner clears the timestamp | Pass |
| DLB-07 | A workspace is deleted | Its domains and mailboxes go with it | Pass |

## Agent service

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| DLV-01 | A correct Google Workspace domain | Everything passes, 3 SPF lookups, score 100, all lists clear | Pass |
| DLV-02 | SPF missing, doubled, `+all`, `?all`, no `all`, a broken redirect, `ptr`, look-alike records | Each reported with its own message | Pass |
| DLV-03 | Nested includes, `a`, `mx` and `exists` reaching 10, then 11 | 10 passes; 11 fails with the count | Pass |
| DLV-04 | An include loop; a Microsoft mailbox without the Microsoft include | Loop ends at 3; the missing include fails with the fix | Pass |
| DLV-05 | Selector order; Microsoft's selector2; a missing custom selector; a revoked key; nothing found; every lookup timing out | Provider first; pass; fail; fail; warning only; not checked | Pass |
| DLV-06 | DMARC missing, `p=none`, no `rua`, bad policy, two records, a subdomain | Fail, warning, warning, fail, fail; the registered domain's record applies | Pass |
| DLV-07 | MX present, missing, null | Pass, fail, fail | Pass |
| DLV-08 | Each list returning a listing; each returning its "refused" code; a list not answering | Listed with the reason; refused shown as not checked with no issue; not answering shown as not checked | Pass |
| DLV-09 | DMARC lookups time out | DMARC not checked; the other checks pass; score unaffected | Pass |
| DLV-10 | Score with none, one of each, many failures | 100, 67, 0 | Pass |
| DLV-11 | The same issue with a changed number; a different issue | Only the different one is new | Pass |
| DLV-12 | Addresses to domains | Lower-cased; non-addresses and `localhost` refused | Pass |
| DLV-13 | Instantly fields with documented codes; unknown codes; no address; numeric top-level domain | Mapped; unknown; skipped; skipped | Pass |
| DLV-14 | A mailbox with four problems; a healthy one | Listed worst first; none | Pass |
| DLV-15 | Two pages; an unrecognised envelope; a cursor that never ends | Both pages read with `starting_after`; an error; stops at the page limit and says so | Pass |
| DLR-01 | First check: two Instantly mailboxes, one failing, two campaign domains, one archived | Both domains checked, archived one ignored; mailboxes stored; two alerts with the fixes and a link | Pass |
| DLR-02 | Again within a day; the next day unchanged | Nothing done; checked again with no new alerts | Pass |
| DLR-03 | A new Spamhaus listing and a banned warm-up | Two critical alerts; score 75 | Pass |
| DLR-04 | The team's selector; a mailbox and a domain removed | The key found at `mx2026`; both removed | Pass |
| DLR-05 | Instantly answers 401 | Flagged in Setup; mailboxes kept; domains still checked | Pass |
| DLR-06 | The sweep with every DNS lookup throwing | The sweep finishes; every check not checked; nothing raised as a failure | Pass |
| DLR-07 | Per-mailbox counts, read as a viewer | 4 sent, 1 bounced, 1 reply for the mailbox; 1 unattributed; a 45-day-old send left out | Pass |

## Web unit

| ID | Test case | Expected result | Actual |
| --- | --- | --- | --- |
| WDLV-01 | Malformed stored issues | Left out; failures listed first | Pass |
| WDLV-02 | Blocklist states | Clear only when every list answered clear | Pass |
| WDLV-03 | Unknown statuses | Never shown as a pass | Pass |
| WDLV-04 | Score bands | Good, needs work, at risk, not checked | Pass |
| WDLV-05 | Mailbox states | Stopped or banned red, healthy green, the rest amber; every code labelled | Pass |
| WDLV-06 | Rates under and at 20 sends | A dash, then a percentage | Pass |
| WDLV-07 | Selectors: spaces, a full `_domainkey` name, blank, invalid, too long | Trimmed, shortened, cleared, refused, refused | Pass |
| WDLV-08 | Labels and explanations | Present for every check | Pass |

## Live checks on the hosted database

| ID | Check | Result |
| --- | --- | --- |
| LIVE-54 | 30 migrations; both tables with row security and 3 policies; signed-in users have SELECT only, plus UPDATE on `dkim_selector`; no visitor grants; visitors cannot call `mailbox_stats`; the workspace column present | **Pass** |
| LIVE-55 | Security advisor | **Pass**: one new entry, `mailbox_stats`, callable by signed-in users by design; it checks membership and returns counts only (§9) |

## Acceptance walkthrough (real accounts)

| ID | Steps | Expected |
| --- | --- | --- |
| ACC-104 | Connect Instantly, press "Check now", wait 15 minutes | Every mailbox and its domain appear with results |
| ACC-105 | Compare a domain's results with MXToolbox | SPF, DMARC and MX agree |
| ACC-106 | Remove DMARC from a test domain and check again | One alert; the next day's check does not repeat it |
| ACC-107 | Send 20 emails from one mailbox | Its sends and bounce rate appear |
