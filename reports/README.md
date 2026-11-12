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
| [F02](F02-multi-tenant-database/feature-report.md) | Multi-tenant database with row-level security | Section 7, 9, 10.1, M15, M20, M21, M23 | 42 passed |

Run every test with `npm test`.
