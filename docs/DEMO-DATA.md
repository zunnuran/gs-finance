# Optional demo data

Fresh installations contain only the administrator. To create fictional data in a separate **development** database after starting the app once, run:

```powershell
npm run db:seed-demo
```

The seed is atomic and idempotent. It creates **GSS Demo Studio** and **GSS Demo Publishing**, a disabled demo author, one client, one vendor, one cash custodian, and four bank/cash accounts. It creates no projects, fixed assets, advances, or reconciliation records. Production refuses both seeding and startup against a demo-seeded database.

The fixture includes 13 documents: 10 Posted, 2 Pending, and 1 Reversed. It covers owner funding, a client invoice and partial receipt, a bank transfer, a cash withdrawal and cash expense, a vendor bill and partial payment, an inter-company transfer, and an expense correction. Pending records can be posted directly by a user with posting permission.

Dates run from 10 to 21 October 2026. Use **1–21 October 2026** for these initial Studio balances:

| Metric | PKR |
| --- | ---: |
| Total bank balance | 1,016,000 |
| Office cash | 40,000 |
| Client receivables | 100,000 |
| Vendor payables | 50,000 |
| Revenue | 300,000 |
| Expenses | 94,000 |
| Profit | 206,000 |

Publishing holds PKR 100,000 in its bank, offset by an inter-company payable. Posting pending documents changes these totals. Seed assertions check the expected balances, document states, and double-entry equality.

## Previously seeded workspaces

The older fixture contained 43 documents, projects, advances, and assets; additional local testing may have added records. Rerunning the updated seed preserves that existing fixture rather than adding another set. The simplified-workflow migration converts its unposted states to Pending while preserving posted records and journals. Old asset and advance transactions remain visible as accounting history, but their creation workflows are no longer available.
