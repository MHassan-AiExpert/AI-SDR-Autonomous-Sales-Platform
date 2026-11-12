# Feature Reports

Every feature of the platform ships with three documents:

| Document | Purpose |
| --- | --- |
| `feature-report.md` | What was built, how it is designed, the decisions behind it and how to operate it |
| `use-cases.md` | Who uses the feature, in which situations, and what the system does |
| `test-cases.md` | Every test case with its steps, expected result and actual result |

## Index

| ID | Feature | SRS reference | Automated tests |
| --- | --- | --- | --- |
| [F01](F01-infrastructure-stack/feature-report.md) | Infrastructure stack: n8n queue mode, Redis job queue, workers | Section 10.2, 10.8 | 14 passed |
| [F02](F02-multi-tenant-database/feature-report.md) | Multi-tenant database with row-level security | Section 7, 9, 10.1, M15, M20, M21, M23 | 43 passed + 4 live checks |
| [F03](F03-web-auth-workspaces/feature-report.md) | Web app: sign-in, workspaces, team roles, channel switches and kill switch | Section 10.1, M21, M23 | 47 passed + 1 live check |
| [F04](F04-onboarding-integrations/feature-report.md) | Guided onboarding: 16 tool connections tested live and stored in Vault, setup checklist, progress | M23, Section 10.1 | 60 passed + 5 live checks |
| [F05](F05-lead-sourcing/feature-report.md) | AI setup agent and lead sourcing: niche to ICP and source plan; Apollo, Google Maps, Instagram and LLM search; de-duplication, suppression, campaigns and leads screens | M1, M2, M14, M15, Section 10 | 101 passed + 2 live checks |
| [F06](F06-enrichment-verification/feature-report.md) | Enrichment and verification: decision makers from Apollo or company websites, ZeroBounce email checks, Twilio line type, daily scheduling | M2, M3, M15, Section 10 | 55 passed + 2 live checks |
| [F07](F07-research-scoring/feature-report.md) | AI research and lead scoring: company briefs, explainable 0-100 scores, outreach threshold, lead profile with timeline | M4, M15, M16, Section 10 | 38 passed + 2 live checks |
| [F08](F08-email-outreach/feature-report.md) | AI copywriting and email outreach: personal sequences, approval review, Instantly sending within limits, pause propagation | M1, M5, M6, M19, M21 | 47 passed + 2 live checks |
| [F09](F09-reply-handling/feature-report.md) | Inbound events and AI reply handling: signed per-workspace webhooks, nine reply types, opt-out and bounce suppression, Slack alerts, inbox | M3, M7, M11, M15 | 43 passed + 2 live checks |

Run the infrastructure and database tests with `npm test`, the agent service tests with `cd agents && npm test`, and the web app tests with `cd web && npm test`.
