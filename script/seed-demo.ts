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

if (process.env.NODE_ENV === "production")
  throw new Error(
    "Demo seeding is disabled in production. Use a separate development database.",
  );

const seedKey = "gss-finance-demo-simple-v2";
const names = ["GSS Demo Studio", "GSS Demo Publishing"];
const asOf = "2026-10-21";

async function seed(c: Connection) {
  await c.query("SELECT pg_advisory_xact_lock(476185912)");
  // Earlier fixtures remain valid historical data; never append a duplicate set.
  const existing = (
    await c.query(
      "SELECT after_value FROM audit WHERE action='demo_seed_completed' AND after_value->>'seedKey' IN ($1,'gss-finance-demo-2026-10-v1') ORDER BY id LIMIT 1",
      [seedKey],
    )
  ).rows[0];
  if (existing)
    return {
      status: "already_seeded",
      seedKey: existing.after_value.seedKey,
      message: "Existing demo data was preserved without changes.",
    };
  if (
    (
      await c.query("SELECT 1 FROM companies WHERE name=ANY($1::text[])", [
        names,
      ])
    ).rows.length
  )
    throw new Error(
      "A demo-named company already exists without a completion marker; no data was changed.",
    );
  const admin = (
    await c.query(
      "SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE u.active AND u.username='admin' AND r.name='super_admin'",
    )
  ).rows[0];
  assert.ok(
    admin,
    "Start the app once to apply migrations and initialize admin before seeding",
  );
  const author = (
    await c.query(
      "INSERT INTO users(username,password,full_name,role_id,active) SELECT 'demo.finance.author',$1,'Demo Finance Author (disabled)',id,false FROM roles WHERE name='finance' RETURNING id",
      [await bcrypt.hash(randomBytes(32).toString("hex"), 12)],
    )
  ).rows[0];
  assert.ok(author, "Finance role is required");
  const studio = await createCompany(c, admin.id, names[0]);
  const publishing = await createCompany(c, admin.id, names[1]);
  const companyIds = [studio.id, publishing.id];
  for (const company of companyIds)
    await c.query("INSERT INTO memberships(user_id,company_id) VALUES($1,$2)", [
      author.id,
      company,
    ]);
  const system = Object.fromEntries(
    (
      await c.query("SELECT id,purpose FROM accounts WHERE company_id=$1", [
        studio.id,
      ])
    ).rows.map((a) => [a.purpose, a.id]),
  );
  async function contact(name: string, kind: string) {
    const row = (
      await c.query(
        "INSERT INTO contacts(company_id,name,kind,email) VALUES($1,$2,$3,$4) RETURNING *",
        [studio.id, name, kind, `${kind}@example.com`],
      )
    ).rows[0];
    await audit(c, studio.id, admin.id, "create", "contact", row.id, null, row);
    return row.id;
  }
  const customer = await contact("Orion Play — Demo Client", "customer");
  const vendor = await contact("Cloud Harbor — Demo Vendor", "vendor");
  const custodian = await contact("Ayesha — Demo Cash Custodian", "employee");
  async function account(
    company: number,
    code: string,
    name: string,
    cash = false,
  ) {
    const row = (
      await c.query(
        "INSERT INTO accounts(company_id,code,name,type,purpose,currency,custodian_id) VALUES($1,$2,$3,'asset',$4,'PKR',$5) RETURNING *",
        [company, code, name, cash ? "cash" : "bank", cash ? custodian : null],
      )
    ).rows[0];
    await audit(c, company, admin.id, "create", "account", row.id, null, row);
    return row.id;
  }
  const bank = await account(studio.id, "1010", "DEMO Operating Bank");
  const savings = await account(studio.id, "1020", "DEMO Savings Bank");
  const cash = await account(studio.id, "1030", "DEMO Office Cash", true);
  const publishingBank = await account(
    publishing.id,
    "1010",
    "DEMO Publishing Bank",
  );
  let count = 0;
  async function document(
    reference: string,
    input: Record<string, unknown>,
    pending = false,
  ) {
    const d = await createDocument(c, studio.id, author.id, {
      date: "2026-10-10",
      currency: "PKR",
      rate: "1",
      ...input,
      reference: `DEMO-${reference}`,
      description: `[DEMO] ${input.description}`,
    });
    count++;
    if (pending) return d;
    return postDocument(c, studio.id, admin.id, d.id);
  }
  await document("CAPITAL", {
    kind: "receipt",
    amount: "1000000",
    targetId: bank,
    headId: system.capital,
    description: "Owner capital contribution",
  });
  const invoice = await document("INVOICE", {
    kind: "invoice",
    amount: "300000",
    contactId: customer,
    headId: system.revenue,
    dueDate: "2026-10-20",
    description: "Client development milestone",
  });
  await document("CLIENT-PAYMENT", {
    kind: "client_payment",
    amount: "200000",
    targetId: bank,
    contactId: customer,
    relatedId: invoice.id,
    description: "Partial client payment",
  });
  await document("TRANSFER", {
    kind: "transfer",
    amount: "100000",
    sourceId: bank,
    targetId: savings,
    description: "Transfer to savings",
  });
  await document("CASH", {
    kind: "withdrawal",
    amount: "50000",
    sourceId: bank,
    targetId: cash,
    description: "Office cash issued to custodian",
  });
  await document("SUPPLIES", {
    kind: "expense",
    amount: "10000",
    sourceId: cash,
    headId: system.office,
    description: "Office supplies paid from cash",
  });
  const bill = await document("BILL", {
    kind: "bill",
    amount: "80000",
    contactId: vendor,
    headId: system.software,
    dueDate: "2026-10-25",
    description: "Cloud services invoice",
  });
  await document("VENDOR-PAYMENT", {
    kind: "vendor_payment",
    amount: "30000",
    sourceId: bank,
    contactId: vendor,
    relatedId: bill.id,
    description: "Partial vendor payment",
  });
  await document("INTERCOMPANY", {
    kind: "intercompany",
    amount: "100000",
    sourceId: bank,
    targetId: publishingBank,
    otherCompanyId: publishing.id,
    description: "Funding transferred to publishing company",
  });
  const correction = await document("CORRECTION", {
    kind: "expense",
    amount: "5000",
    sourceId: bank,
    headId: system.office,
    description: "Expense recorded with an incorrect amount",
  });
  await reverseDocument(c, studio.id, admin.id, correction.id, "2026-10-11");
  await document("CORRECTED", {
    kind: "expense",
    date: "2026-10-11",
    amount: "4000",
    sourceId: bank,
    headId: system.office,
    description: "Corrected office expense",
  });
  await document(
    "PENDING-CASH",
    {
      kind: "expense",
      date: asOf,
      amount: "2500",
      sourceId: cash,
      headId: system.office,
      description: "Pending cash expense — ready to post",
    },
    true,
  );
  await document(
    "PENDING-BILL",
    {
      kind: "bill",
      date: asOf,
      amount: "12000",
      contactId: vendor,
      headId: system.software,
      description: "Pending vendor bill — ready to post",
    },
    true,
  );
  const result = await reports(c, studio.id, "2026-10-01", asOf);
  for (const [key, expected] of Object.entries({
    bank: "1016000.00",
    cash: "40000.00",
    receivable: "100000.00",
    payable: "50000.00",
    revenue: "300000.00",
    expenses: "94000.00",
    profit: "206000.00",
  }))
    assert.equal(
      result.summary[key as keyof typeof result.summary],
      expected,
      `Expected demo ${key}`,
    );
  assert.equal(
    new Decimal(
      result.trial.reduce(
        (sum, row) => sum.plus(row.debit).minus(row.credit),
        new Decimal(0),
      ),
    ).toFixed(2),
    "0.00",
  );
  assert.equal(
    (
      await c.query(
        "SELECT j.id FROM journals j JOIN journal_lines l ON l.journal_id=j.id WHERE j.company_id=ANY($1::int[]) GROUP BY j.id HAVING sum(l.debit)<>sum(l.credit)",
        [companyIds],
      )
    ).rows.length,
    0,
  );
  const statuses = (
    await c.query(
      "SELECT status,count(*)::int count FROM documents WHERE company_id=ANY($1::int[]) GROUP BY status ORDER BY status",
      [companyIds],
    )
  ).rows;
  assert.deepEqual(
    Object.fromEntries(statuses.map((s) => [s.status, s.count])),
    { pending: 2, posted: 10, reversed: 1 },
  );
  const summary = {
    status: "seeded",
    seedKey,
    asOf,
    documents: count,
    statuses,
    companies: [
      { id: studio.id, name: studio.name, summary: result.summary },
      { id: publishing.id, name: publishing.name },
    ],
    author: { username: "demo.finance.author", active: false },
  };
  await audit(
    c,
    studio.id,
    admin.id,
    "demo_seed_completed",
    "demo_seed",
    studio.id,
    null,
    summary,
  );
  return summary;
}

try {
  console.log(JSON.stringify(await transaction(seed), null, 2));
} catch (error) {
  console.error("Demo seed failed; the transaction was rolled back.");
  console.error(error instanceof Error ? error.message : "Unknown seed error");
  process.exitCode = 1;
} finally {
  await pool.end();
}
