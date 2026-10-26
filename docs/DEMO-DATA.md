# Demo data and verification

This optional development fixture creates two fictional workspaces: **GSS Demo Studio** and **GSS Demo Publishing**. Fresh installations contain no sample companies or transactions. Demo contacts use `example.com`; bank and tax details are explicitly fictional. Use a separate development database; demo seeding is disabled in production.

## Reproduce the sample data

After configuring the dedicated application database and starting the app once to initialize its administrator and migrations, run:

```powershell
npm run db:seed-demo
```

The seed creates both companies in one database transaction, validates the financial results, and records a completion marker. Running it again leaves existing records unchanged. It will refuse to alter a company with the same name that lacks its completion marker. It does not reset demo changes made through the app.

The fixture contains 43 documents: 38 posted, one reversed, and one each in draft, submitted, approved, and rejected states. It includes three projects, three clients, three vendors, two employee custodians, PKR and USD accounts, partial and full settlements, advances, two assets, exchange differences, an inter-company transfer, and a reversal with a correcting expense. The demo author is disabled and has no usable shared password; use your existing administrator login.

Dates are fixed from 25 September through 21 October 2026. Use **1–21 October 2026** to see the baseline dashboard below. Changing demo transactions or posting depreciation will change these totals.

| Studio metric | PKR |
| --- | ---: |
| Bank balance | 2,032,500 |
| Cash with custodians | 115,000 |
| Accounts receivable | 540,000 |
| Accounts payable | 200,000 |
| Outstanding advances | 55,000 |
| Due from Demo Publishing | 200,000 |
| October revenue | 2,020,000 |
| October expenses, including exchange gains | 917,500 |
| October profit | 1,102,500 |
| Fixed asset acquisition cost | 480,000 |

The USD bank holds USD 1,500 with a PKR carrying value of 423,000. Ayesha holds PKR 70,000 cash and Hamza holds PKR 45,000 cash, plus a separate PKR 55,000 advance. Publishing has PKR 540,000 in its bank, PKR 200,000 due to Studio, and PKR 40,000 October profit. September invoice revenue of PKR 120,000 appears in cumulative earnings, outside October profit.

A sample PNG attachment was uploaded to `DEMO-CASH-001` during the local smoke test. It is an application screenshot for upload testing, not a receipt, and is not part of the repeatable database seed. Depreciation and bank reconciliation can be tried from their workflows; they are tested automatically but not posted by the seed.

## Verification completed on 21 October 2026

- TypeScript check and production build passed.
- 39 source tests passed: 25 accounting tests and 14 HTTP tests against a dedicated PostgreSQL test database.
- All 14 HTTP tests also passed against the compiled production server.
- Seed assertions verified every journal, both trial balances and balance sheets, account balances, aging, allocations, exchange rates, assets, and the exclusion of unposted review items.
- Rerunning the seed returned `already_seeded` without duplicate documents.
- Live API checks verified October totals, September balances, all three project filters, inbound inter-company visibility, and authenticated attachment upload/download.
- Browser checks covered the populated dashboard, remembered company selection after reload, project filtering of recent activity, account/custodian balances, receivables, payables, advances, asset register, profit and loss, trial balance, transaction search, and attachment visibility.

Testing identified and fixed two defects: automatic exchange gains were grouped under the expense's business category, and a contact assigned as a cash custodian could change from employee to vendor. Regression tests cover both, including historical category remapping and reversals.

The interface now remembers the selected company per user and applies dashboard date/project filters to recent transactions as well as report totals.

The automated HTTP suite creates and removes isolated schemas in `gss_finance_test`; it does not use the populated application database. See the README for test commands and production deployment limitations.
