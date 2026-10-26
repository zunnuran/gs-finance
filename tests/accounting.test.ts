import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import Decimal from "decimal.js";
import {
  createCompany,
  createDocument,
  postDocument,
  reverseDocument,
} from "../server/accounting";
import { reports } from "../server/reports";
import type { Connection } from "../server/db";

// PostgreSQL itself executes constraints and PL/pgSQL; no ledger/storage mocks.
const database = new PGlite();
const connection: Connection = {
  async query(sql, values = []) {
    const result = await database.query<Record<string, any>>(
      sql,
      values.map((v) => (v === undefined ? null : v)),
    );
    // Match pg's configured DATE parser; timestamps remain Date values.
    const dateFields = result.fields
      .filter((f) => f.dataTypeID === 1082)
      .map((f) => f.name);
    for (const row of result.rows)
      for (const field of dateFields)
        if (row[field] instanceof Date)
          row[field] = row[field].toISOString().slice(0, 10);
    return { rows: result.rows, rowCount: result.affectedRows };
  },
};
async function tx<T>(fn: (c: Connection) => Promise<T>) {
  await connection.query("BEGIN");
  try {
    const result = await fn(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}
let userId: number;
before(async () => {
  for (const filename of readdirSync("migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await database.exec(readFileSync(`migrations/${filename}`, "utf8"));
  const role = (
    await connection.query(
      "INSERT INTO roles(name) VALUES('super_admin') RETURNING id",
    )
  ).rows[0].id;
  userId = (
    await connection.query(
      "INSERT INTO users(username,password,full_name,role_id) VALUES('test-admin','test-only','Test Admin',$1) RETURNING id",
      [role],
    )
  ).rows[0].id;
});
after(async () => {
  await database.close();
});

async function fixture(name: string) {
  const company = await tx((c) => createCompany(c, userId, name));
  await connection.query("UPDATE companies SET approvals=false WHERE id=$1", [
    company.id,
  ]);
  const system = Object.fromEntries(
    (
      await connection.query(
        "SELECT purpose,id FROM accounts WHERE company_id=$1",
        [company.id],
      )
    ).rows.map((a) => [a.purpose, a.id]),
  );
  async function account(
    code: string,
    purpose = "bank",
    currency = "PKR",
    custodian: number | null = null,
  ) {
    return (
      await connection.query(
        "INSERT INTO accounts(company_id,code,name,type,purpose,currency,custodian_id) VALUES($1,$2,$3,'asset',$4,$5,$6) RETURNING id",
        [company.id, code, `${name} ${code}`, purpose, currency, custodian],
      )
    ).rows[0].id;
  }
  async function contact(kind: string) {
    return (
      await connection.query(
        "INSERT INTO contacts(company_id,name,kind) VALUES($1,$2,$3) RETURNING id",
        [company.id, `${name} ${kind}`, kind],
      )
    ).rows[0].id;
  }
  const employee = await contact("employee"),
    customer = await contact("customer"),
    vendor = await contact("vendor");
  const bank = await account("101"),
    bank2 = await account("102"),
    cash = await account("103", "cash", "PKR", employee),
    usd = await account("104", "bank", "USD");
  async function draft(input: Record<string, unknown>) {
    return tx((c) =>
      createDocument(c, company.id, userId, {
        date: "2026-10-10",
        amount: "100.00",
        description: "Test transaction",
        ...input,
      }),
    );
  }
  async function post(input: Record<string, unknown>) {
    const d = await draft(input);
    return tx((c) => postDocument(c, company.id, userId, d.id));
  }
  async function balance(accountId: number) {
    return (
      await connection.query(
        "SELECT COALESCE(sum(debit-credit),0)::text balance FROM journal_lines WHERE company_id=$1 AND account_id=$2",
        [company.id, accountId],
      )
    ).rows[0].balance;
  }
  async function expectBalance(accountId: number, expected: string) {
    assert.equal(
      new Decimal(await balance(accountId)).toFixed(2),
      new Decimal(expected).toFixed(2),
    );
  }
  return {
    company,
    system,
    employee,
    customer,
    vendor,
    bank,
    bank2,
    cash,
    usd,
    account,
    contact,
    draft,
    post,
    balance,
    expectBalance,
  };
}

test("cash custody, transfers and expenses preserve double entry without recognizing transfer income", async () => {
  const f = await fixture("Cash custody");
  await f.post({
    kind: "receipt",
    amount: "100000",
    targetId: f.bank,
    headId: f.system.capital,
  });
  await f.post({
    kind: "transfer",
    amount: "20000",
    sourceId: f.bank,
    targetId: f.bank2,
  });
  await f.post({
    kind: "withdrawal",
    amount: "50000",
    sourceId: f.bank,
    targetId: f.cash,
  });
  await f.post({
    kind: "expense",
    amount: "15000",
    sourceId: f.cash,
    headId: f.system.office,
    contactId: f.employee,
  });
  await f.expectBalance(f.bank, "30000");
  await f.expectBalance(f.bank2, "20000");
  await f.expectBalance(f.cash, "35000");
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(r.summary.revenue, "0.00");
  assert.equal(r.summary.expenses, "15000.00");
  assert.equal(r.summary.cash, "35000.00");
  assert.equal(
    new Decimal(
      r.trial.reduce(
        (n: Decimal, row: any) => n.plus(row.debit).minus(row.credit),
        new Decimal(0),
      ),
    ).toFixed(2),
    "0.00",
  );
});

test("advances settle through eligible expenses and returned cash without duplicate expense recognition", async () => {
  const f = await fixture("Advances");
  await f.post({
    kind: "receipt",
    amount: "100000",
    targetId: f.bank,
    headId: f.system.capital,
  });
  const advance = await f.post({
    kind: "advance",
    amount: "50000",
    sourceId: f.bank,
    contactId: f.employee,
  });
  await f.post({
    kind: "advance_expense",
    amount: "35000",
    relatedId: advance.id,
    contactId: f.employee,
    headId: f.system.office,
  });
  await f.expectBalance(f.system.advance, "15000");
  await f.post({
    kind: "advance_return",
    amount: "15000",
    relatedId: advance.id,
    contactId: f.employee,
    targetId: f.bank,
  });
  await f.expectBalance(f.system.advance, "0");
  await f.expectBalance(f.system.office, "35000");
  await f.expectBalance(f.bank, "65000");
  const excess = await f.draft({
    kind: "advance_return",
    amount: "0.01",
    relatedId: advance.id,
    contactId: f.employee,
    targetId: f.bank,
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, excess.id)),
    /outstanding/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [excess.id],
      )
    ).rows[0].n,
    0,
  );
});

test("partial client payments clear historic receivables and record only the realized exchange difference", async () => {
  const f = await fixture("Foreign receivables");
  const invoice = await f.post({
    kind: "invoice",
    amount: "1000",
    currency: "USD",
    rate: "280",
    contactId: f.customer,
    headId: f.system.revenue,
  });
  await f.post({
    kind: "client_payment",
    amount: "400",
    currency: "USD",
    rate: "285",
    contactId: f.customer,
    targetId: f.usd,
    relatedId: invoice.id,
  });
  await f.expectBalance(f.system.receivable, "168000");
  await f.expectBalance(f.usd, "114000");
  await f.expectBalance(f.system.fx, "-2000");
  await f.post({
    kind: "client_payment",
    amount: "600",
    currency: "USD",
    rate: "282",
    contactId: f.customer,
    targetId: f.usd,
    relatedId: invoice.id,
  });
  await f.expectBalance(f.system.receivable, "0");
  await f.expectBalance(f.usd, "283200");
  await f.expectBalance(f.system.fx, "-3200");
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(r.summary.revenue, "280000.00");
  assert.equal(r.summary.profit, "283200.00");
});

test("vendor bill recognizes expense once and partial payments clear the payable", async () => {
  const f = await fixture("Vendor settlement");
  await f.post({
    kind: "receipt",
    amount: "200000",
    targetId: f.bank,
    headId: f.system.capital,
  });
  const bill = await f.post({
    kind: "bill",
    amount: "100000",
    contactId: f.vendor,
    headId: f.system.software,
  });
  await f.post({
    kind: "vendor_payment",
    amount: "40000",
    contactId: f.vendor,
    sourceId: f.bank,
    relatedId: bill.id,
  });
  await f.expectBalance(f.system.payable, "-60000");
  await f.expectBalance(f.system.software, "100000");
  await f.post({
    kind: "vendor_payment",
    amount: "60000",
    contactId: f.vendor,
    sourceId: f.bank,
    relatedId: bill.id,
  });
  await f.expectBalance(f.system.payable, "0");
  await f.expectBalance(f.bank, "100000");
});

test("asset purchases create a fixed asset and unpaid acquisition can be settled", async () => {
  const f = await fixture("Assets");
  const asset = await f.post({
    kind: "asset_purchase",
    amount: "300000",
    contactId: f.vendor,
    assetName: "Workstation",
    usefulLife: 36,
    salvage: "12000",
  });
  await f.expectBalance(f.system.fixed_asset, "300000");
  await f.expectBalance(f.system.payable, "-300000");
  const record = (
    await connection.query("SELECT * FROM assets WHERE document_id=$1", [
      asset.id,
    ])
  ).rows[0];
  assert.equal(record.name, "Workstation");
  assert.equal(Number(record.cost), 300000);
  assert.equal(record.useful_life, 36);
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(r.summary.expenses, "0.00");
  await f.post({
    kind: "receipt",
    amount: "300000",
    targetId: f.bank,
    headId: f.system.capital,
  });
  await f.post({
    kind: "vendor_payment",
    amount: "300000",
    sourceId: f.bank,
    contactId: f.vendor,
    relatedId: asset.id,
  });
  await f.expectBalance(f.system.payable, "0");
});

test("inter-company transfers create balanced linked ledgers and reverse both atomically", async () => {
  const a = await fixture("Company A"),
    b = await fixture("Company B");
  await a.post({
    kind: "receipt",
    amount: "500000",
    targetId: a.bank,
    headId: a.system.capital,
  });
  const transfer = await a.post({
    kind: "intercompany",
    amount: "200000",
    sourceId: a.bank,
    targetId: b.bank,
    otherCompanyId: b.company.id,
  });
  await a.expectBalance(a.bank, "300000");
  await a.expectBalance(a.system.due_from, "200000");
  await b.expectBalance(b.bank, "200000");
  await b.expectBalance(b.system.due_to, "-200000");
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [transfer.id],
      )
    ).rows[0].n,
    2,
  );
  await tx((c) =>
    reverseDocument(c, a.company.id, userId, transfer.id, "2026-10-11"),
  );
  await a.expectBalance(a.bank, "500000");
  await a.expectBalance(a.system.due_from, "0");
  await b.expectBalance(b.bank, "0");
  await b.expectBalance(b.system.due_to, "0");
});

test("duplicate posting is idempotent and reversal preserves original lines", async () => {
  const f = await fixture("Posting idempotency");
  const receipt = await f.post({
    kind: "receipt",
    amount: "1000",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  await tx((c) => postDocument(c, f.company.id, userId, receipt.id));
  await f.expectBalance(f.bank, "1000");
  const originals = (
    await connection.query(
      "SELECT l.* FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.document_id=$1",
      [receipt.id],
    )
  ).rows;
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, receipt.id, "2026-10-11"),
  );
  await f.expectBalance(f.bank, "0");
  const unchanged = (
    await connection.query(
      "SELECT * FROM journal_lines WHERE id=ANY($1::int[]) ORDER BY id",
      [originals.map((l) => l.id)],
    )
  ).rows;
  assert.deepEqual(unchanged, originals);
  await assert.rejects(
    () =>
      tx((c) =>
        reverseDocument(c, f.company.id, userId, receipt.id, "2026-10-11"),
      ),
    /only posted/i,
  );
});

test("period locks, approvals and account ownership reject posting without partial ledger writes", async () => {
  const f = await fixture("Controls"),
    other = await fixture("Other company");
  const d = await f.draft({
    kind: "receipt",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  await connection.query("UPDATE companies SET approvals=true WHERE id=$1", [
    f.company.id,
  ]);
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, d.id)),
    /approval/i,
  );
  await connection.query("UPDATE documents SET status='approved' WHERE id=$1", [
    d.id,
  ]);
  await connection.query(
    "UPDATE companies SET locked_through='2026-10-10' WHERE id=$1",
    [f.company.id],
  );
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, d.id)),
    /locked/i,
  );
  await connection.query(
    "UPDATE companies SET locked_through=NULL,approvals=false WHERE id=$1",
    [f.company.id],
  );
  const cross = await f.draft({
    kind: "receipt",
    targetId: other.bank,
    headId: f.system.revenue,
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, cross.id)),
    /belonging to this company/i,
  );
  const wrongCurrency = await f.draft({
    kind: "receipt",
    currency: "USD",
    rate: "280",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, wrongCurrency.id)),
    /currency/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE company_id=$1",
        [f.company.id],
      )
    ).rows[0].n,
    0,
  );
});

test("reversing a settled invoice is blocked until its payments are reversed", async () => {
  const f = await fixture("Reversal dependencies");
  const invoice = await f.post({
    kind: "invoice",
    amount: "1000",
    headId: f.system.revenue,
    contactId: f.customer,
  });
  const payment = await f.post({
    kind: "client_payment",
    amount: "500",
    targetId: f.bank,
    contactId: f.customer,
    relatedId: invoice.id,
  });
  await assert.rejects(
    () =>
      tx((c) =>
        reverseDocument(c, f.company.id, userId, invoice.id, "2026-10-11"),
      ),
    /settlements first/i,
  );
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, payment.id, "2026-10-11"),
  );
  await f.expectBalance(f.system.receivable, "1000");
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, invoice.id, "2026-10-11"),
  );
  await f.expectBalance(f.system.receivable, "0");
  await f.expectBalance(f.system.revenue, "0");
});

test("database rejects unbalanced journals and mutations of posted ledger entries", async () => {
  const f = await fixture("Database invariants");
  const d = await f.draft({
    kind: "receipt",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  await assert.rejects(
    () =>
      tx(async (c) => {
        const j = (
          await c.query(
            "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3) RETURNING id",
            [f.company.id, d.id, d.date],
          )
        ).rows[0].id;
        await c.query(
          "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,currency) VALUES($1,$2,$3,100,0,'PKR'),($1,$2,$4,0,90,'PKR')",
          [j, f.company.id, f.bank, f.system.revenue],
        );
      }),
    /balanced/i,
  );
  await tx((c) => postDocument(c, f.company.id, userId, d.id));
  await assert.rejects(
    () =>
      connection.query(
        "UPDATE journal_lines SET debit=debit+1 WHERE account_id=$1 AND debit>0",
        [f.bank],
      ),
    /immutable/i,
  );
  await assert.rejects(
    () =>
      connection.query("DELETE FROM journal_lines WHERE account_id=$1", [
        f.bank,
      ]),
    /immutable/i,
  );
});

test("invalid dates, rates and nonpositive amounts never enter the document store", async () => {
  const f = await fixture("Input validation");
  for (const input of [
    { date: "2026-02-30" },
    { amount: "0" },
    { amount: "-1" },
    { rate: "0" },
    { rate: "2", currency: "PKR" },
  ]) {
    await assert.rejects(() =>
      f.draft({
        kind: "receipt",
        targetId: f.bank,
        headId: f.system.revenue,
        ...input,
      }),
    );
  }
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM documents WHERE company_id=$1",
        [f.company.id],
      )
    ).rows[0].n,
    0,
  );
});

test("cash and bank payments cannot spend more than the available currency balance", async () => {
  const f = await fixture("Insufficient funds");
  for (const sourceId of [f.bank, f.cash]) {
    const d = await f.draft({
      kind: "expense",
      sourceId,
      headId: f.system.office,
    });
    await assert.rejects(
      () => tx((c) => postDocument(c, f.company.id, userId, d.id)),
      /insufficient|available|balance|overdraw/i,
    );
  }
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE company_id=$1",
        [f.company.id],
      )
    ).rows[0].n,
    0,
  );
});

test("foreign cash spending realizes carrying-value differences and leaves no base residual when emptied", async () => {
  const f = await fixture("Foreign cash carrying");
  await f.post({
    kind: "receipt",
    targetId: f.usd,
    headId: f.system.capital,
    amount: "100",
    currency: "USD",
    rate: "280",
  });
  await f.post({
    kind: "expense",
    sourceId: f.usd,
    headId: f.system.software,
    amount: "100",
    currency: "USD",
    rate: "285",
  });
  await f.expectBalance(f.usd, "0");
  await f.expectBalance(f.system.software, "28500");
  await f.expectBalance(f.system.fx, "-500");
  const foreign = (
    await connection.query(
      "SELECT sum(foreign_amount)::text total FROM journal_lines WHERE account_id=$1",
      [f.usd],
    )
  ).rows[0].total;
  assert.ok(new Decimal(foreign).isZero());
});

test("same-currency transfers carry historic value without recognizing gains or losses", async () => {
  const f = await fixture("Foreign internal transfer");
  const destination = await f.account("105", "bank", "USD");
  await f.post({
    kind: "receipt",
    targetId: f.usd,
    headId: f.system.capital,
    amount: "100",
    currency: "USD",
    rate: "280",
  });
  await f.post({
    kind: "transfer",
    sourceId: f.usd,
    targetId: destination,
    amount: "100",
    currency: "USD",
    rate: "285",
  });
  await f.expectBalance(f.usd, "0");
  await f.expectBalance(destination, "28000");
  await f.expectBalance(f.system.fx, "0");
});

test("cross-currency transfers use actual received amount and realize exchange differences", async () => {
  const f = await fixture("Currency conversion");
  await f.post({
    kind: "receipt",
    targetId: f.usd,
    headId: f.system.capital,
    amount: "100",
    currency: "USD",
    rate: "280",
  });
  await f.post({
    kind: "transfer",
    sourceId: f.usd,
    targetId: f.bank,
    amount: "100",
    currency: "USD",
    rate: "285",
    targetAmount: "28500",
    targetRate: "1",
  });
  await f.expectBalance(f.usd, "0");
  await f.expectBalance(f.bank, "28500");
  await f.expectBalance(f.system.fx, "-500");
  const destinationCurrency = (
    await connection.query(
      "SELECT DISTINCT currency FROM journal_lines WHERE account_id=$1",
      [f.bank],
    )
  ).rows.map((r) => r.currency);
  assert.deepEqual(destinationCurrency, ["PKR"]);
});

test("credit-side opening balances correctly establish a liability", async () => {
  const f = await fixture("Credit opening");
  await f.post({
    kind: "opening",
    amount: "100000",
    targetId: f.system.loan,
    openingSide: "credit",
  });
  await f.expectBalance(f.system.loan, "-100000");
  await f.expectBalance(f.system.opening, "100000");
});

test("settlements and reversals cannot precede the original transaction", async () => {
  const f = await fixture("Chronology");
  const invoice = await f.post({
    kind: "invoice",
    amount: "1000",
    headId: f.system.revenue,
    contactId: f.customer,
  });
  const payment = await f.draft({
    kind: "client_payment",
    amount: "500",
    date: "2026-10-09",
    targetId: f.bank,
    contactId: f.customer,
    relatedId: invoice.id,
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, payment.id)),
    /date|precede|before/i,
  );
  await assert.rejects(
    () =>
      tx((c) =>
        reverseDocument(c, f.company.id, userId, invoice.id, "2026-10-09"),
      ),
    /date|precede|before/i,
  );
});

test("database rejects empty journal headers and late inserts into a posted journal", async () => {
  const f = await fixture("Ledger append protections");
  const draft = await f.draft({
    kind: "receipt",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  await assert.rejects(
    () =>
      tx(async (c) => {
        await c.query(
          "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3)",
          [f.company.id, draft.id, draft.date],
        );
      }),
    /balanced|entries|lines|empty/i,
  );
  const posted = await f.post({
    kind: "receipt",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  const journal = (
    await connection.query("SELECT id FROM journals WHERE document_id=$1", [
      posted.id,
    ])
  ).rows[0].id;
  await assert.rejects(
    () =>
      tx(async (c) => {
        await c.query(
          "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,currency) VALUES($1,$2,$3,1,0,'PKR'),($1,$2,$4,0,1,'PKR')",
          [journal, f.company.id, f.bank, f.system.revenue],
        );
      }),
    /immutable|posted|sealed/i,
  );
});

test("historical aging honors payment and reversal dates instead of present document status", async () => {
  const f = await fixture("Historical aging");
  const invoice = await f.post({
    kind: "invoice",
    amount: "1000",
    headId: f.system.revenue,
    contactId: f.customer,
    date: "2026-10-01",
    dueDate: "2026-10-05",
  });
  const payment = await f.post({
    kind: "client_payment",
    amount: "400",
    targetId: f.bank,
    contactId: f.customer,
    relatedId: invoice.id,
    date: "2026-10-10",
  });
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, payment.id, "2026-10-20"),
  );
  const beforePayment = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-05",
  );
  assert.equal(beforePayment.agingReceivables[0].outstanding, "1000.00");
  const beforeReversal = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-15",
  );
  assert.equal(beforeReversal.agingReceivables[0].outstanding, "600.00");
  assert.equal(beforeReversal.summary.receivable, "600.00");
  assert.equal(beforeReversal.agingReceivables[0].daysOverdue, 10);
  const afterReversal = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-21",
  );
  assert.equal(afterReversal.agingReceivables[0].outstanding, "1000.00");
  assert.equal(afterReversal.summary.receivable, "1000.00");
  await assert.rejects(
    () =>
      tx((c) =>
        reverseDocument(c, f.company.id, userId, invoice.id, "2026-10-19"),
      ),
    /settlement|reversal|date/i,
  );
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, invoice.id, "2026-10-21"),
  );
  const afterInvoiceReversal = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-22",
  );
  assert.deepEqual(afterInvoiceReversal.agingReceivables, []);
});

test("backdated foreign receipts cannot alter the carrying basis of later account activity", async () => {
  const f = await fixture("Foreign receipt chronology");
  await f.post({
    kind: "receipt",
    amount: "100",
    currency: "USD",
    rate: "280",
    targetId: f.usd,
    headId: f.system.capital,
    date: "2026-10-10",
  });
  await f.post({
    kind: "expense",
    amount: "50",
    currency: "USD",
    rate: "285",
    sourceId: f.usd,
    headId: f.system.software,
    date: "2026-10-12",
  });
  const backdated = await f.draft({
    kind: "receipt",
    amount: "100",
    currency: "USD",
    rate: "290",
    targetId: f.usd,
    headId: f.system.capital,
    date: "2026-10-11",
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, backdated.id)),
    /date|precede|before|chronolog/i,
  );
  await f.expectBalance(f.usd, "14000");
});

test("capital vendor bills require asset metadata and create an asset once supplied", async () => {
  const f = await fixture("Capital vendor bill");
  const missing = await f.draft({
    kind: "bill",
    amount: "300000",
    contactId: f.vendor,
    headId: f.system.fixed_asset,
  });
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, missing.id)),
    /asset name|useful life|salvage/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [missing.id],
      )
    ).rows[0].n,
    0,
  );
  const capitalBill = await f.post({
    kind: "bill",
    amount: "300000",
    contactId: f.vendor,
    headId: f.system.fixed_asset,
    assetName: "Render workstation",
    usefulLife: 36,
    salvage: "0",
  });
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM assets WHERE document_id=$1",
        [capitalBill.id],
      )
    ).rows[0].n,
    1,
  );
  await f.expectBalance(f.system.fixed_asset, "300000");
  await f.expectBalance(f.system.payable, "-300000");
  await f.post({
    kind: "receipt",
    amount: "300000",
    headId: f.system.capital,
    targetId: f.bank,
  });
  await f.post({
    kind: "vendor_payment",
    amount: "300000",
    contactId: f.vendor,
    sourceId: f.bank,
    relatedId: capitalBill.id,
  });
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(
    r.cashFlow.find((row: any) => row.name === "Investing")?.balance,
    "-300000.00",
  );
});

test("aged base balances preserve allocated rounding and final payment clears the residual exactly", async () => {
  const f = await fixture("Settlement rounding");
  const invoice = await f.post({
    kind: "invoice",
    amount: "0.03",
    currency: "USD",
    rate: "1.5",
    contactId: f.customer,
    headId: f.system.revenue,
  });
  for (let i = 0; i < 2; i++)
    await f.post({
      kind: "client_payment",
      amount: "0.01",
      currency: "USD",
      rate: "1.5",
      contactId: f.customer,
      targetId: f.usd,
      relatedId: invoice.id,
    });
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(r.agingReceivables[0].outstanding, "0.01");
  assert.equal(r.agingReceivables[0].outstandingBase, "0.01");
  assert.equal(r.summary.receivable, "0.01");
  await f.post({
    kind: "client_payment",
    amount: "0.01",
    currency: "USD",
    rate: "1.5",
    contactId: f.customer,
    targetId: f.usd,
    relatedId: invoice.id,
  });
  await f.expectBalance(f.system.receivable, "0");
});

test("reports retain cents when aggregating values above the safe integer range", async () => {
  const f = await fixture("Report decimal precision");
  for (let i = 0; i < 10; i++)
    await f.post({
      kind: "receipt",
      amount: "9999999999999.99",
      targetId: f.bank,
      headId: f.system.revenue,
    });
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(r.summary.bank, "99999999999999.90");
  assert.equal(r.summary.revenue, "99999999999999.90");
  assert.equal(r.balanceSheet.earnings, "99999999999999.90");
});

test("expense category reports keep realized exchange differences separate from the operating expense", async () => {
  const f = await fixture("Category FX");
  const category = (
    await connection.query(
      "INSERT INTO categories(company_id,name,account_id) VALUES($1,'Cloud hosting',$2) RETURNING id",
      [f.company.id, f.system.office],
    )
  ).rows[0].id;
  await f.post({
    kind: "receipt",
    amount: "100",
    currency: "USD",
    rate: "280",
    targetId: f.usd,
    headId: f.system.capital,
  });
  const expense = await f.post({
    kind: "expense",
    amount: "100",
    currency: "USD",
    rate: "290",
    sourceId: f.usd,
    categoryId: category,
  });
  const r = await reports(connection, f.company.id, "2026-10-01", "2026-10-31");
  assert.equal(
    r.byCategory.find((row: any) => row.name === "Cloud hosting")?.balance,
    "29000.00",
    "Expense category records the purchase at its transaction-date rate",
  );
  assert.equal(
    r.byCategory.find((row: any) => row.name === "Exchange gain / loss")
      ?.balance,
    "-1000.00",
    "The gain on foreign cash is reported separately",
  );
  assert.equal(r.summary.expenses, "28000.00");
  assert.equal(
    r.byCategory
      .reduce(
        (total: Decimal, row: any) => total.plus(row.balance),
        new Decimal(0),
      )
      .toFixed(2),
    r.summary.expenses,
  );
  await connection.query("UPDATE categories SET account_id=$1 WHERE id=$2", [
    f.system.software,
    category,
  ]);
  const remapped = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-31",
  );
  assert.equal(
    remapped.byCategory.find((row: any) => row.name === "Cloud hosting")
      ?.balance,
    "29000.00",
    "Changing a category's future posting account preserves its historic expense attribution",
  );
  await f.expectBalance(f.system.office, "29000.00");
  await f.expectBalance(f.system.software, "0.00");
  await tx((c) =>
    reverseDocument(c, f.company.id, userId, expense.id, "2026-10-20"),
  );
  const reversal = await reports(
    connection,
    f.company.id,
    "2026-10-20",
    "2026-10-31",
  );
  assert.equal(
    reversal.byCategory.find((row: any) => row.name === "Cloud hosting")
      ?.balance,
    "-29000.00",
  );
  assert.equal(
    reversal.byCategory.find((row: any) => row.name === "Exchange gain / loss")
      ?.balance,
    "1000.00",
  );
});

test("receiving-company period locks roll back the whole inter-company posting and reversal", async () => {
  const a = await fixture("Atomic source"),
    b = await fixture("Atomic destination");
  await a.post({
    kind: "receipt",
    amount: "10000",
    targetId: a.bank,
    headId: a.system.capital,
  });
  const d = await a.draft({
    kind: "intercompany",
    amount: "1000",
    sourceId: a.bank,
    targetId: b.bank,
    otherCompanyId: b.company.id,
  });
  await connection.query(
    "UPDATE companies SET locked_through='2026-10-10' WHERE id=$1",
    [b.company.id],
  );
  await assert.rejects(
    () => tx((c) => postDocument(c, a.company.id, userId, d.id)),
    /locked/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [d.id],
      )
    ).rows[0].n,
    0,
  );
  await a.expectBalance(a.bank, "10000");
  await b.expectBalance(b.bank, "0");
  await connection.query(
    "UPDATE companies SET locked_through=NULL WHERE id=$1",
    [b.company.id],
  );
  await tx((c) => postDocument(c, a.company.id, userId, d.id));
  await connection.query(
    "UPDATE companies SET locked_through='2026-10-11' WHERE id=$1",
    [b.company.id],
  );
  await assert.rejects(
    () =>
      tx((c) => reverseDocument(c, a.company.id, userId, d.id, "2026-10-11")),
    /locked/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [d.id],
      )
    ).rows[0].n,
    2,
  );
  await a.expectBalance(a.bank, "9000");
  await b.expectBalance(b.bank, "1000");
  assert.equal(
    (await connection.query("SELECT status FROM documents WHERE id=$1", [d.id]))
      .rows[0].status,
    "posted",
  );
});
