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
| [F10](F10-answers-booking/feature-report.md) | AI answers and meeting booking: in-thread answers with approval, single-use Calendly links, signed booking notifications, meetings | M1, M7, M8, M11, M21 | 38 passed + 2 live checks |
| [F11](F11-ai-voice-calling/feature-report.md) | AI voice calling: consent and Do Not Call rules, calling hours and limits, AI disclosure, outcomes, transcripts and recordings | M3, M11, M12, M15, M21 | 41 passed + 2 live checks |
| [F12](F12-sms-whatsapp-follow-ups/feature-report.md) | SMS and WhatsApp follow-ups: consent per channel, contact hours and limits, AI-written texts with sender and opt-out, two-way replies, STOP handling, delivery tracking | M3, M6, M7, M13, M17, M21 | 43 passed + 2 live checks |
| [F13](F13-ai-closer/feature-report.md) | AI closer: playbook-led meeting calls, plan and price from the playbook, Stripe payment links, PandaDoc proposals, payments win the deal, handoffs to the team | M11, M15, M18, M19, M20, M21 | 43 passed + 2 live checks |
| [F14](F14-ai-receptionist/feature-report.md) | Inbound AI receptionist: per-call setup from notes and playbook, transfers to the team, booking links by text with consent, callers become leads | M3, M8, M11, M15, M25 | 36 passed + 2 live checks |
| [F15](F15-website-audits/feature-report.md) | Website and marketing audits: 13 checks measured in code, AI recommendations for failed checks, private tracked page, first email links to it, opens alert the team | M5, M11, M15, M16 | 36 passed + 2 live checks |
| [F16](F16-self-learning/feature-report.md) | Self-learning: weekly results measured in code with significance tests, copy lessons and threshold suggestions with evidence, approval or auto-apply | M4, M5, M10, M11, M24 | 35 passed + 2 live checks |
| [F17](F17-analytics-dashboard/feature-report.md) | Reporting and analytics: funnel with step rates, daily chart, channel and campaign results, revenue, cost per meeting, safe CSV export | M10, M20, M23 | 26 passed + 2 live checks |
| [F18](F18-crm-sync/feature-report.md) | CRM sync with HubSpot: contacts by email with lead status, deals in a chosen pipeline, activity notes, wins and losses read back, only changes sent | M9, M20, M23 | 41 passed + 2 live checks |
| [F19](F19-monitoring-notifications/feature-report.md) | Monitoring, alerts and notifications: in-app notification centre, Slack events and quiet hours, one-click handoffs, retries with backoff, automatic email pausing on bounce or opt-out spikes, tool and credit alerts, daily summary, readiness endpoint | M11, M22, FR-23.4, 10.4, 10.6 | 46 passed + 2 live checks |
| [F20](F20-white-label/feature-report.md) | White-label mode: agency brand on custom domains and in client workspaces, agency console with client plans, limits and usage, CSV usage export, default playbook and cadence, isolation through workspace roles | M26, 10.1 | 34 passed + 2 live checks |
| [F21](F21-csv-import-bulk-actions/feature-report.md) | CSV import with the same hygiene as sourced leads, import history and undo, and bulk stage, owner, campaign and suppress actions | M3, M15 | 34 passed |
| [F22](F22-conditional-branching-ab-testing/feature-report.md) | Conditional branching: steps choose the next action from what the lead did on any channel, with up to three A/B messages per step scored by the learning agent | M6, M7, M24 | 48 passed + 3 live checks |
| [F23](F23-template-library/feature-report.md) | Shared template library: save and apply sequences, snippets the copywriter draws on, agency defaults inherited by new client workspaces, and the playbook's objection answers wired into the reply agent | M4, M6, M26 | 37 passed |

Run the infrastructure and database tests with `npm test`, the agent service tests with `cd agents && npm test`, and the web app tests with `cd web && npm test`.
