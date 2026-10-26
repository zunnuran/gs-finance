import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import Decimal from "decimal.js";
import {
  audit,
  createCompany,
  createDocument,
  postDocument,
  reverseDocument,
} from "../server/accounting";
import { pool, transaction, type Connection } from "../server/db";
import { reports } from "../server/reports";
import type { DocumentInput } from "../shared/domain";

if (process.env.NODE_ENV === "production")
  throw new Error(
    "Demo seeding is disabled in production. Use a separate development database.",
  );

// Fixed dates make this fixture reproducible. All amounts are fictional, and all
// financial records belong to separate, visibly named demonstration companies.
const SEED_KEY = "gss-finance-demo-2026-10-v1";
const AS_OF = "2026-10-21";
const COMPANY_NAMES = ["GSS Demo Studio", "GSS Demo Publishing"];
const AUTHOR_USERNAME = "demo.finance.author";
type ReviewState = "draft" | "submitted" | "approved" | "rejected" | "posted";
type SeedInput = Pick<
  DocumentInput,
  "kind" | "date" | "amount" | "description"
> &
  Partial<DocumentInput>;
type DemoCompany = {
  id: number;
  name: string;
  accounts: Record<string, number>;
  categories: Record<string, number>;
};
const money = (amount: Decimal.Value) => new Decimal(amount).toFixed(2);
const total = (rows: any[], field: string) =>
  rows.reduce((sum, row) => sum.plus(row[field]), new Decimal(0));

async function seed(c: Connection) {
  // The lock, master data, postings, verification, and completion marker all
  // commit together. An interrupted run never leaves half a demonstration set.
  await c.query("SELECT pg_advisory_xact_lock(476185912)");
  const completed = (
    await c.query(
      "SELECT after_value FROM audit WHERE action='demo_seed_completed' AND entity='demo_seed' AND after_value->>'seedKey'=$1 ORDER BY id LIMIT 1",
      [SEED_KEY],
    )
  ).rows[0];
  if (completed) {
    const ids = completed.after_value.companies.map(
      (co: { id: number }) => co.id,
    );
    const existing = (
      await c.query(
        "SELECT id,name FROM companies WHERE id=ANY($1::integer[])",
        [ids],
      )
    ).rows;
    assert.equal(
      existing.length,
      2,
      "Demo seed marker exists but a company is missing",
    );
    return {
      status: "already_seeded",
      message:
        "Demo data already exists; no records were changed or duplicated.",
      seedKey: SEED_KEY,
      companies: existing,
      asOf: AS_OF,
    };
  }
  const collision = (
    await c.query("SELECT name FROM companies WHERE name=ANY($1::text[])", [
      COMPANY_NAMES,
    ])
  ).rows;
  assert.equal(
    collision.length,
    0,
    "A demo company name already exists without this seed's completion marker; refusing to alter existing data",
  );
  const admin = (
    await c.query(
      "SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active AND r.name='super_admin' ORDER BY u.id LIMIT 1",
    )
  ).rows[0];
  assert.ok(
    admin,
    "Run migrations/bootstrap before seeding: an active Super Admin is required",
  );
  const finance = (await c.query("SELECT id FROM roles WHERE name='finance'"))
    .rows[0];
  assert.ok(finance, "Finance role is missing; run migrations/bootstrap first");
  assert.equal(
    (await c.query("SELECT id FROM users WHERE username=$1", [AUTHOR_USERNAME]))
      .rows.length,
    0,
    "The reserved demo author already exists without this seed's completion marker",
  );
  // Never create or expose a usable demo credential. Review actors remain
  // distinct, while the author cannot sign in or obtain a session.
  const author = (
    await c.query(
      "INSERT INTO users(username,password,full_name,role_id,active) VALUES($1,$2,$3,$4,false) RETURNING id,username,full_name,role_id,active",
      [
        AUTHOR_USERNAME,
        await bcrypt.hash(randomBytes(48).toString("base64url"), 12),
        "Demo Finance Author (disabled)",
        finance.id,
      ],
    )
  ).rows[0];
  await audit(c, null, admin.id, "create", "user", author.id, null, author);

  async function company(name: string): Promise<DemoCompany> {
    const row = await createCompany(c, admin.id, name);
    assert.equal(row.approvals, true);
    await c.query("INSERT INTO memberships(user_id,company_id) VALUES($1,$2)", [
      author.id,
      row.id,
    ]);
    const accounts = Object.fromEntries(
      (
        await c.query("SELECT id,purpose FROM accounts WHERE company_id=$1", [
          row.id,
        ])
      ).rows.map((a) => [a.purpose, a.id]),
    );
    const categories = Object.fromEntries(
      (
        await c.query("SELECT id,name FROM categories WHERE company_id=$1", [
          row.id,
        ])
      ).rows.map((a) => [a.name, a.id]),
    );
    return { id: row.id, name, accounts, categories };
  }
  const studio = await company(COMPANY_NAMES[0]);
  const publishing = await company(COMPANY_NAMES[1]);
  async function contact(
    co: DemoCompany,
    name: string,
    kind: string,
    email: string,
  ) {
    const row = (
      await c.query(
        "INSERT INTO contacts(company_id,name,kind,email,phone,tax_number,bank_details) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [
          co.id,
          name,
          kind,
          email,
          "DEMO — no real phone number",
          kind === "employee" ? "" : "DEMO-TAX-NOT-VALID",
          kind === "employee"
            ? ""
            : "DEMO bank details — not a payment destination",
        ],
      )
    ).rows[0];
    await audit(c, co.id, admin.id, "create", "contact", row.id, null, row);
    return row.id as number;
  }
  async function project(co: DemoCompany, name: string) {
    const row = (
      await c.query(
        "INSERT INTO projects(company_id,name) VALUES($1,$2) RETURNING *",
        [co.id, name],
      )
    ).rows[0];
    await audit(c, co.id, admin.id, "create", "project", row.id, null, row);
    return row.id as number;
  }
  async function cashAccount(
    co: DemoCompany,
    code: string,
    name: string,
    currency = "PKR",
    custodian: number | null = null,
  ) {
    const row = (
      await c.query(
        "INSERT INTO accounts(company_id,code,name,type,purpose,currency,custodian_id) VALUES($1,$2,$3,'asset',$4,$5,$6) RETURNING *",
        [co.id, code, name, custodian ? "cash" : "bank", currency, custodian],
      )
    ).rows[0];
    await audit(c, co.id, admin.id, "create", "account", row.id, null, row);
    return row.id as number;
  }
  const customers = {
    orion: await contact(
      studio,
      "Orion Play — Demo Client",
      "customer",
      "orion.play@example.com",
    ),
    nimbus: await contact(
      studio,
      "Nimbus Labs — Demo Client",
      "customer",
      "nimbus.labs@example.com",
    ),
    harbor: await contact(
      studio,
      "Harbor Interactive — Demo Client",
      "customer",
      "harbor.interactive@example.com",
    ),
  };
  const vendors = {
    cloud: await contact(
      studio,
      "Cloud Harbor — Demo Vendor",
      "vendor",
      "cloud.harbor@example.com",
    ),
    software: await contact(
      studio,
      "DevKit Tools — Demo Vendor",
      "vendor",
      "devkit.tools@example.com",
    ),
    hardware: await contact(
      studio,
      "Pixel Hardware — Demo Vendor",
      "vendor",
      "pixel.hardware@example.com",
    ),
  };
  const employees = {
    admin: await contact(
      studio,
      "Ayesha — Demo Office Admin",
      "employee",
      "ayesha.demo@example.com",
    ),
    manager: await contact(
      studio,
      "Hamza — Demo Project Manager",
      "employee",
      "hamza.demo@example.com",
    ),
  };
  const projects = {
    game: await project(studio, "Project Nebula — Demo Game"),
    mobile: await project(studio, "Pixel Quest — Demo Mobile Game"),
    platform: await project(studio, "Nimbus Platform — Demo IT Services"),
  };
  const op = await cashAccount(studio, "1010", "DEMO Operating Bank · PKR");
  const savings = await cashAccount(studio, "1020", "DEMO Savings Bank · PKR");
  const usd = await cashAccount(
    studio,
    "1030",
    "DEMO Foreign Currency Bank · USD",
    "USD",
  );
  const adminCash = await cashAccount(
    studio,
    "1040",
    "DEMO Ayesha · Office Cash",
    "PKR",
    employees.admin,
  );
  const managerCash = await cashAccount(
    studio,
    "1050",
    "DEMO Hamza · Project Cash",
    "PKR",
    employees.manager,
  );
  const publishingBank = await cashAccount(
    publishing,
    "1010",
    "DEMO Publishing Bank · PKR",
  );
  const docIds: Record<string, number> = {};
  async function document(
    key: string,
    input: SeedInput,
    state: ReviewState = "posted",
    co = studio,
  ) {
    assert.ok(input.date <= AS_OF, "Seed documents cannot be future-dated");
    let doc = await createDocument(c, co.id, author.id, {
      currency: "PKR",
      rate: "1",
      ...input,
      amount: money(input.amount),
      reference: `DEMO-${key}`,
      description: `[DEMO] ${input.description}`,
    });
    const change = async (status: string, action: string, actor: number) => {
      const before = doc;
      doc = (
        await c.query(
          "UPDATE documents SET status=$1,approved_by=$2 WHERE id=$3 RETURNING *",
          [status, status === "approved" ? admin.id : null, doc.id],
        )
      ).rows[0];
      await audit(c, co.id, actor, action, "document", doc.id, before, doc);
    };
    if (state !== "draft") await change("submitted", "submit", author.id);
    if (state === "rejected") await change("rejected", "reject", admin.id);
    if (state === "approved" || state === "posted")
      await change("approved", "approve", admin.id);
    if (state === "posted")
      doc = await postDocument(c, co.id, admin.id, doc.id);
    docIds[key] = doc.id;
    return doc.id as number;
  }
  const category = (name: string) => ({ categoryId: studio.categories[name] });
  const invoice = (
    date: string,
    amount: string,
    customer: number,
    projectId: number,
    description: string,
  ): SeedInput => ({
    kind: "invoice",
    date,
    amount,
    contactId: customer,
    projectId,
    headId: studio.accounts.revenue,
    description,
  });
  const septemberInvoice = await document("INV-SEP-001", {
    ...invoice(
      "2026-09-25",
      "120000",
      customers.harbor,
      projects.game,
      "September game prototype milestone; partly overdue",
    ),
    dueDate: "2026-10-05",
  });
  await document("FUND-001", {
    kind: "receipt",
    date: "2026-10-01",
    amount: "2000000",
    targetId: op,
    headId: studio.accounts.capital,
    description: "Owner capital contribution for studio operations",
  });
  await document("TRANSFER-001", {
    kind: "transfer",
    date: "2026-10-01",
    amount: "500000",
    sourceId: op,
    targetId: savings,
    description: "Move working capital into business savings",
  });
  const orionInvoice = await document("INV-001", {
    ...invoice(
      "2026-10-02",
      "600000",
      customers.orion,
      projects.game,
      "Project Nebula vertical slice milestone",
    ),
    dueDate: "2026-10-15",
  });
  const nimbusInvoice = await document("INV-002", {
    ...invoice(
      "2026-10-03",
      "250000",
      customers.nimbus,
      projects.platform,
      "Nimbus Platform sprint delivery",
    ),
    dueDate: "2026-10-10",
  });
  await document("INV-003", {
    ...invoice(
      "2026-10-03",
      "180000",
      customers.harbor,
      projects.mobile,
      "Pixel Quest art integration milestone",
    ),
    dueDate: "2026-10-30",
  });
  const usdInvoice = await document("INV-USD-001", {
    ...invoice(
      "2026-10-04",
      "3000",
      customers.orion,
      projects.game,
      "Overseas game development milestone in USD",
    ),
    currency: "USD",
    rate: "280",
    dueDate: "2026-10-18",
  });
  const cloudBill = await document("BILL-001", {
    kind: "bill",
    date: "2026-10-04",
    amount: "120000",
    contactId: vendors.cloud,
    projectId: projects.game,
    ...category("Cloud services"),
    dueDate: "2026-10-14",
    description: "October multiplayer hosting invoice",
  });
  const licenseBill = await document("BILL-002", {
    kind: "bill",
    date: "2026-10-05",
    amount: "80000",
    contactId: vendors.software,
    projectId: projects.platform,
    ...category("Software licenses"),
    dueDate: "2026-10-12",
    description: "Team development tool licenses",
  });
  await document("WITHDRAW-001", {
    kind: "withdrawal",
    date: "2026-10-05",
    amount: "100000",
    sourceId: op,
    targetId: adminCash,
    description: "Office cash entrusted to Ayesha",
  });
  await document("WITHDRAW-002", {
    kind: "withdrawal",
    date: "2026-10-05",
    amount: "60000",
    sourceId: op,
    targetId: managerCash,
    description: "Project cash entrusted to Hamza",
  });
  await document("CASH-001", {
    kind: "expense",
    date: "2026-10-06",
    amount: "20000",
    sourceId: adminCash,
    contactId: employees.admin,
    ...category("Office supplies"),
    description: "Office stationery and supplies paid from Ayesha's cash",
  });
  await document("CASH-002", {
    kind: "expense",
    date: "2026-10-06",
    amount: "10000",
    sourceId: adminCash,
    contactId: employees.admin,
    ...category("Internet"),
    description: "Office internet paid from Ayesha's cash",
  });
  await document("CASH-003", {
    kind: "expense",
    date: "2026-10-06",
    amount: "15000",
    sourceId: managerCash,
    contactId: employees.manager,
    projectId: projects.mobile,
    ...category("Client meetings"),
    description: "Pixel Quest client review meeting paid from project cash",
  });
  await document("CLIENT-PAY-001", {
    kind: "client_payment",
    date: "2026-10-07",
    amount: "300000",
    targetId: op,
    contactId: customers.orion,
    projectId: projects.game,
    relatedId: orionInvoice,
    description: "Orion partial payment; PKR 300,000 remains due",
  });
  await document("CLIENT-PAY-002", {
    kind: "client_payment",
    date: "2026-10-07",
    amount: "250000",
    targetId: op,
    contactId: customers.nimbus,
    projectId: projects.platform,
    relatedId: nimbusInvoice,
    description: "Nimbus invoice paid in full",
  });
  await document("VENDOR-PAY-001", {
    kind: "vendor_payment",
    date: "2026-10-08",
    amount: "40000",
    sourceId: op,
    contactId: vendors.cloud,
    projectId: projects.game,
    relatedId: cloudBill,
    description: "Partial hosting payment; PKR 80,000 remains payable",
  });
  await document("VENDOR-PAY-002", {
    kind: "vendor_payment",
    date: "2026-10-08",
    amount: "80000",
    sourceId: op,
    contactId: vendors.software,
    projectId: projects.platform,
    relatedId: licenseBill,
    description: "Development licenses paid in full",
  });
  const settledAdvance = await document("ADV-001", {
    kind: "advance",
    date: "2026-10-08",
    amount: "50000",
    sourceId: op,
    contactId: employees.admin,
    ...category("Travel"),
    description: "Ayesha travel advance for studio supplier visits",
  });
  const openAdvance = await document("ADV-002", {
    kind: "advance",
    date: "2026-10-09",
    amount: "80000",
    sourceId: op,
    contactId: employees.manager,
    projectId: projects.game,
    description: "Hamza project travel and purchasing advance",
  });
  await document("ASSET-001", {
    kind: "asset_purchase",
    date: "2026-10-09",
    amount: "300000",
    sourceId: op,
    contactId: vendors.hardware,
    projectId: projects.game,
    ...category("Workstations"),
    assetName: "DEMO Nebula artist workstation",
    usefulLife: 36,
    salvage: "30000",
    description: "Artist workstation purchased and paid immediately",
  });
  const unpaidAsset = await document("ASSET-002", {
    kind: "asset_purchase",
    date: "2026-10-10",
    amount: "180000",
    contactId: vendors.hardware,
    projectId: projects.platform,
    ...category("Servers"),
    assetName: "DEMO Build and test server",
    usefulLife: 48,
    salvage: "20000",
    dueDate: "2026-10-25",
    description: "Build server acquired on supplier credit",
  });
  await document("CLIENT-PAY-USD-001", {
    kind: "client_payment",
    date: "2026-10-10",
    amount: "3000",
    currency: "USD",
    rate: "282",
    targetId: usd,
    contactId: customers.orion,
    projectId: projects.game,
    relatedId: usdInvoice,
    description: "USD milestone paid in full at PKR 282 per USD",
  });
  await document("USD-EXPENSE-001", {
    kind: "expense",
    date: "2026-10-11",
    amount: "500",
    currency: "USD",
    rate: "283",
    sourceId: usd,
    contactId: vendors.cloud,
    projectId: projects.game,
    ...category("Cloud services"),
    description:
      "USD hosting charge with automatic carrying-value exchange adjustment",
  });
  await document("ADV-SETTLE-001", {
    kind: "advance_expense",
    date: "2026-10-11",
    amount: "35000",
    contactId: employees.admin,
    relatedId: settledAdvance,
    ...category("Travel"),
    description: "Ayesha submits eligible travel receipts against her advance",
  });
  await document("ADV-RETURN-001", {
    kind: "advance_return",
    date: "2026-10-12",
    amount: "15000",
    targetId: op,
    contactId: employees.admin,
    relatedId: settledAdvance,
    description: "Ayesha returns unused advance; advance fully settled",
  });
  await document("ADV-SETTLE-002", {
    kind: "advance_expense",
    date: "2026-10-12",
    amount: "25000",
    contactId: employees.manager,
    relatedId: openAdvance,
    projectId: projects.game,
    ...category("Travel"),
    description:
      "Hamza submits project travel receipts; PKR 55,000 remains held",
  });
  await document("FX-TRANSFER-001", {
    kind: "transfer",
    date: "2026-10-13",
    amount: "1000",
    currency: "USD",
    rate: "284",
    sourceId: usd,
    targetId: op,
    targetAmount: "284000",
    targetRate: "1",
    description: "Convert USD 1,000 into PKR 284,000 in the operating bank",
  });
  await document("ASSET-PAY-001", {
    kind: "vendor_payment",
    date: "2026-10-14",
    amount: "60000",
    sourceId: op,
    contactId: vendors.hardware,
    projectId: projects.platform,
    relatedId: unpaidAsset,
    description: "Build server first installment; PKR 120,000 remains payable",
  });
  await document("INTERCO-001", {
    kind: "intercompany",
    date: "2026-10-14",
    amount: "200000",
    sourceId: op,
    targetId: publishingBank,
    otherCompanyId: publishing.id,
    description:
      "Funding advanced to GSS Demo Publishing; reciprocal due-from and due-to balances",
  });
  await document("CLIENT-PAY-SEP-001", {
    kind: "client_payment",
    date: "2026-10-15",
    amount: "60000",
    targetId: op,
    contactId: customers.harbor,
    projectId: projects.game,
    relatedId: septemberInvoice,
    description:
      "Half of September milestone collected; PKR 60,000 still overdue",
  });
  await document("RECEIPT-001", {
    kind: "receipt",
    date: "2026-10-15",
    amount: "150000",
    targetId: op,
    headId: studio.accounts.revenue,
    contactId: customers.nimbus,
    projectId: projects.platform,
    description: "Same-day IT consulting service paid immediately",
  });
  await document("SALARIES-001", {
    kind: "expense",
    date: "2026-10-16",
    amount: "450000",
    sourceId: op,
    projectId: projects.game,
    ...category("Salaries"),
    description: "October game production team payroll expense",
  });
  const reversed = await document("CORRECTION-ORIGINAL", {
    kind: "expense",
    date: "2026-10-17",
    amount: "30000",
    sourceId: op,
    ...category("Electricity"),
    description:
      "Electricity amount entered incorrectly; reversed on October 18",
  });
  await reverseDocument(c, studio.id, admin.id, reversed, "2026-10-18");
  await document("CORRECTION-REPLACEMENT", {
    kind: "expense",
    date: "2026-10-18",
    amount: "27000",
    sourceId: op,
    ...category("Electricity"),
    description:
      "Corrected electricity invoice replacing DEMO-CORRECTION-ORIGINAL",
  });
  await document("BANK-FEE-001", {
    kind: "expense",
    date: "2026-10-19",
    amount: "2500",
    sourceId: op,
    ...category("Bank charges"),
    description: "Monthly bank service charges",
  });
  await document(
    "DRAFT-001",
    {
      kind: "expense",
      date: "2026-10-20",
      amount: "18000",
      sourceId: op,
      ...category("Training"),
      description: "Draft employee learning workshop; no ledger impact",
    },
    "draft",
  );
  await document(
    "SUBMITTED-001",
    {
      kind: "expense",
      date: "2026-10-20",
      amount: "22000",
      sourceId: adminCash,
      contactId: employees.admin,
      ...category("Office supplies"),
      description: "Office supply request awaiting independent review",
    },
    "submitted",
  );
  await document(
    "APPROVED-001",
    {
      kind: "expense",
      date: "2026-10-20",
      amount: "12000",
      sourceId: op,
      projectId: projects.mobile,
      ...category("Software licenses"),
      description: "Approved art tool license awaiting payment posting",
    },
    "approved",
  );
  await document(
    "REJECTED-001",
    {
      kind: "expense",
      date: "2026-10-21",
      amount: "45000",
      sourceId: op,
      ...category("Events"),
      description: "Event expense rejected for missing business justification",
    },
    "rejected",
  );
  await document(
    "PUB-FUND-001",
    {
      kind: "receipt",
      date: "2026-10-01",
      amount: "300000",
      targetId: publishingBank,
      headId: publishing.accounts.capital,
      description: "Publishing company owner contribution",
    },
    "posted",
    publishing,
  );
  await document(
    "PUB-MARKETING-001",
    {
      kind: "expense",
      date: "2026-10-16",
      amount: "50000",
      sourceId: publishingBank,
      categoryId: publishing.categories.Advertising,
      description: "Game launch advertising campaign",
    },
    "posted",
    publishing,
  );
  await document(
    "PUB-RECEIPT-001",
    {
      kind: "receipt",
      date: "2026-10-17",
      amount: "90000",
      targetId: publishingBank,
      headId: publishing.accounts.revenue,
      description: "Game publishing service payment",
    },
    "posted",
    publishing,
  );

  const studioReport = await reports(c, studio.id, "2026-10-01", AS_OF);
  const publishingReport = await reports(c, publishing.id, "2026-10-01", AS_OF);
  assert.deepEqual(
    studioReport.summary,
    {
      bank: "2032500.00",
      cash: "115000.00",
      receivable: "540000.00",
      payable: "200000.00",
      advances: "55000.00",
      intercompany: "200000.00",
      revenue: "2020000.00",
      expenses: "917500.00",
      profit: "1102500.00",
      cashFlow: "2147500.00",
    },
    "Studio report must match independently calculated demo expectations",
  );
  assert.deepEqual(publishingReport.summary, {
    bank: "540000.00",
    cash: "0.00",
    receivable: "0.00",
    payable: "0.00",
    advances: "0.00",
    intercompany: "-200000.00",
    revenue: "90000.00",
    expenses: "50000.00",
    profit: "40000.00",
    cashFlow: "540000.00",
  });
  for (const report of [studioReport, publishingReport]) {
    assert.equal(
      total(report.trial, "debit").toFixed(2),
      total(report.trial, "credit").toFixed(2),
      "Trial balance must balance",
    );
    const sheet = report.balanceSheet;
    assert.equal(
      total(sheet.assets, "balance")
        .plus(total(sheet.liabilities, "balance"))
        .plus(total(sheet.equity, "balance"))
        .minus(sheet.earnings)
        .toFixed(2),
      "0.00",
      "Balance sheet must balance",
    );
  }
  const expectedAccounts = new Map([
    [op, "1109500.00"],
    [savings, "500000.00"],
    [usd, "423000.00"],
    [adminCash, "70000.00"],
    [managerCash, "45000.00"],
  ]);
  for (const [accountId, balance] of expectedAccounts)
    assert.equal(
      studioReport.trial.find((row) => row.id === accountId)?.balance,
      balance,
    );
  assert.equal(studioReport.agingReceivables.length, 3);
  assert.equal(
    total(studioReport.agingReceivables, "outstandingBase").toFixed(2),
    "540000.00",
  );
  assert.equal(
    total(studioReport.agingPayables, "outstandingBase").toFixed(2),
    "200000.00",
  );
  assert.equal(studioReport.outstandingAdvances.length, 1);
  assert.equal(studioReport.outstandingAdvances[0].outstanding, "55000.00");
  assert.equal(
    studioReport.agingReceivables.find((row) => row.id === septemberInvoice)
      ?.daysOverdue,
    16,
  );
  const usdBalance = (
    await c.query(
      "SELECT sum(foreign_amount) nominal FROM journal_lines WHERE account_id=$1",
      [usd],
    )
  ).rows[0];
  assert.equal(money(usdBalance.nominal), "1500.00");
  const unbalanced = (
    await c.query(
      "SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=ANY($1::integer[]) GROUP BY j.id HAVING sum(l.debit)<>sum(l.credit)",
      [[studio.id, publishing.id]],
    )
  ).rows;
  assert.equal(
    unbalanced.length,
    0,
    "Every journal must balance independently",
  );
  const companyIds = [studio.id, publishing.id];
  const statuses = (
    await c.query(
      "SELECT status,count(*)::int count FROM documents WHERE company_id=ANY($1::integer[]) GROUP BY status ORDER BY status",
      [companyIds],
    )
  ).rows;
  assert.deepEqual(
    Object.fromEntries(statuses.map((s) => [s.status, s.count])),
    {
      approved: 1,
      draft: 1,
      posted: 38,
      rejected: 1,
      reversed: 1,
      submitted: 1,
    },
  );
  const nonPostedJournals = (
    await c.query(
      "SELECT j.id FROM journals j JOIN documents d ON d.id=j.document_id WHERE j.company_id=ANY($1::integer[]) AND d.status NOT IN ('posted','reversed')",
      [companyIds],
    )
  ).rows;
  assert.equal(nonPostedJournals.length, 0);
  const assets = (
    await c.query(
      "SELECT name,cost,salvage,useful_life FROM assets WHERE company_id=ANY($1::integer[]) ORDER BY id",
      [companyIds],
    )
  ).rows;
  assert.equal(assets.length, 2);
  assert.equal(total(assets, "cost").toFixed(2), "480000.00");
  const result = {
    status: "seeded",
    seedKey: SEED_KEY,
    asOf: AS_OF,
    companies: [
      { id: studio.id, name: studio.name, summary: studioReport.summary },
      {
        id: publishing.id,
        name: publishing.name,
        summary: publishingReport.summary,
      },
    ],
    documents: Object.keys(docIds).length,
    statuses,
    assets: assets.length,
    usdBankNominal: "1500.00",
    author: { username: AUTHOR_USERNAME, active: false },
    checks:
      "Balanced journals, trial balances, balance sheets, balances, aging, settlements, FX, assets, and review-state isolation passed.",
  };
  assert.equal(result.documents, 43);
  await audit(
    c,
    studio.id,
    admin.id,
    "demo_seed_completed",
    "demo_seed",
    studio.id,
    null,
    result,
  );
  return result;
}

try {
  const result = await transaction(seed);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("Demo seed failed; the entire transaction was rolled back.");
  console.error(error instanceof Error ? error.message : "Unknown seed error");
  process.exitCode = 1;
} finally {
  await pool.end();
}
