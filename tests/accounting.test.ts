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

test("workflow migration converts only unposted statuses and preserves ledger history and posting permissions", async () => {
  const legacy = new PGlite();
  try {
    const files = readdirSync("migrations")
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const migration = files.find((f) => f.startsWith("005_"));
    assert.ok(migration, "The pending-workflow migration must exist");
    for (const file of files.filter((f) => f < migration))
      await legacy.exec(readFileSync(`migrations/${file}`, "utf8"));
    await legacy.exec(`
      INSERT INTO roles(id,name,permissions) VALUES(1,'finance','["transactions.view","transactions.submit","transactions.approve","transactions.post"]');
      INSERT INTO users(id,username,password,full_name,role_id,overrides) VALUES(1,'legacy-admin','fixture-only','Legacy administrator',1,'{"transactions.approve":true,"transactions.submit":false,"transactions.post":false,"reports.view":true}');
      INSERT INTO companies(id,name,approvals) VALUES(1,'Retained company',true);
      INSERT INTO accounts(id,company_id,code,name,type,purpose) VALUES(1,1,'101','Bank','asset','bank'),(2,1,'300','Capital','equity','capital');
      INSERT INTO projects(id,company_id,name) VALUES(1,1,'Retained project');
      INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,project_id)
        SELECT 1,'receipt','2026-10-01',100,'PKR',1,100,s,s,1,1 FROM unnest(ARRAY['draft','submitted','approved','rejected','posted','cancelled','reversed']) s;
      BEGIN;
      INSERT INTO journals(id,company_id,document_id,date) SELECT id,1,id,'2026-10-01' FROM documents WHERE status IN ('posted','reversed');
      INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,foreign_amount,currency)
        SELECT id,1,1,100,0,100,'PKR' FROM journals UNION ALL SELECT id,1,2,0,100,-100,'PKR' FROM journals;
      COMMIT;
    `);
    const postedBefore = (
      await legacy.query(
        "SELECT * FROM documents WHERE status IN ('posted','reversed') ORDER BY id",
      )
    ).rows;
    const journalBefore = (
      await legacy.query("SELECT * FROM journals ORDER BY id")
    ).rows;
    const linesBefore = (
      await legacy.query("SELECT * FROM journal_lines ORDER BY id")
    ).rows;
    await legacy.exec(readFileSync(`migrations/${migration}`, "utf8"));
    const docs = (
      await legacy.query<{
        description: string;
        status: string;
        project_id: number;
      }>("SELECT description,status,project_id FROM documents ORDER BY id")
    ).rows;
    for (const doc of docs) {
      assert.equal(
        doc.status,
        ["draft", "submitted", "approved", "rejected"].includes(doc.description)
          ? "pending"
          : doc.description,
      );
      assert.equal(
        doc.project_id,
        1,
        "Retiring Projects must preserve historical links",
      );
    }
    assert.deepEqual(
      (
        await legacy.query(
          "SELECT * FROM documents WHERE status IN ('posted','reversed') ORDER BY id",
        )
      ).rows,
      postedBefore,
    );
    assert.deepEqual(
      (await legacy.query("SELECT * FROM journals ORDER BY id")).rows,
      journalBefore,
    );
    assert.deepEqual(
      (await legacy.query("SELECT * FROM journal_lines ORDER BY id")).rows,
      linesBefore,
    );
    assert.equal(
      (
        await legacy.query<{ approvals: boolean }>(
          "SELECT approvals FROM companies WHERE id=1",
        )
      ).rows[0].approvals,
      false,
    );
    const role = (
      await legacy.query<{ permissions: string[] }>(
        "SELECT permissions FROM roles WHERE id=1",
      )
    ).rows[0];
    assert.deepEqual(
      role.permissions.filter((p) => p.startsWith("transactions.")).sort(),
      ["transactions.post", "transactions.view"],
    );
    const user = (
      await legacy.query<{ overrides: Record<string, boolean> }>(
        "SELECT overrides FROM users WHERE id=1",
      )
    ).rows[0];
    assert.deepEqual(user.overrides, {
      "transactions.post": false,
      "reports.view": true,
    });
    const auditRows = (
      await legacy.query<{
        before_value: { status: string };
        after_value: { status: string };
      }>(
        "SELECT before_value,after_value FROM audit WHERE action='workflow_migration' ORDER BY entity_id",
      )
    ).rows;
    assert.deepEqual(
      auditRows.map((row) => row.before_value.status),
      ["draft", "submitted", "approved", "rejected"],
    );
    assert.ok(auditRows.every((row) => row.after_value.status === "pending"));
    const fresh = (
      await legacy.query<{ status: string }>(
        "INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,created_by) VALUES(1,'expense','2026-10-02',10,'PKR',1,10,'New pending',1) RETURNING status",
      )
    ).rows[0];
    assert.equal(fresh.status, "pending");
    await assert.rejects(
      () =>
        legacy.query(
          "UPDATE documents SET status='approved' WHERE description='draft'",
        ),
      /check|constraint/i,
    );
  } finally {
    await legacy.close();
  }
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

// Create retained pre-removal history as a fixture, never through a retired API.
async function historicalPosting(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: string,
  debit: number,
  credit: number,
  amount: string,
  contactId: number | null = null,
) {
  return tx(async (c) => {
    const doc = (
      await c.query(
        "INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,contact_id,extra) VALUES($1,$2,'2026-10-01',$3,'PKR',1,$3,'Historical module fixture','posted',$4,$5,'{}') RETURNING *",
        [f.company.id, kind, amount, userId, contactId],
      )
    ).rows[0];
    const journal = (
      await c.query(
        "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3) RETURNING id",
        [f.company.id, doc.id, doc.date],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,foreign_amount,currency,contact_id) VALUES($1,$2,$3,$5,0,$5,'PKR',$6),($1,$2,$4,0,$5,-$5,'PKR',$6)",
      [journal, f.company.id, debit, credit, amount, contactId],
    );
    return doc;
  });
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

test("retired advance and asset actions cannot create new documents or post retained pending records", async () => {
  const f = await fixture("Retired modules");
  const before = (
    await connection.query(
      "SELECT count(*)::int n FROM documents WHERE company_id=$1",
      [f.company.id],
    )
  ).rows[0].n;
  for (const kind of [
    "advance",
    "advance_expense",
    "advance_return",
    "asset_purchase",
    "depreciation",
  ])
    await assert.rejects(
      () => f.draft({ kind, sourceId: f.bank, contactId: f.employee }),
      /unavailable|removed|retired|supported/i,
    );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM documents WHERE company_id=$1",
        [f.company.id],
      )
    ).rows[0].n,
    before,
  );
  const old = (
    await connection.query(
      "INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,status,created_by,source_id,contact_id) VALUES($1,'advance','2026-10-01',100,'PKR',1,100,'Historical pending advance','pending',$2,$3,$4) RETURNING id",
      [f.company.id, userId, f.bank, f.employee],
    )
  ).rows[0];
  await assert.rejects(
    () => tx((c) => postDocument(c, f.company.id, userId, old.id)),
    /unavailable|removed|retired|supported/i,
  );
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM journals WHERE document_id=$1",
        [old.id],
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

test("historical asset acquisitions remain in reports and their unpaid balance can still be settled", async () => {
  const f = await fixture("Retained assets");
  const asset = await historicalPosting(
    f,
    "asset_purchase",
    f.system.fixed_asset,
    f.system.payable,
    "300000",
    f.vendor,
  );
  await connection.query(
    "INSERT INTO assets(company_id,document_id,name,cost,salvage,useful_life,acquired) VALUES($1,$2,'Legacy workstation',300000,12000,36,'2026-10-01')",
    [f.company.id, asset.id],
  );
  await f.expectBalance(f.system.fixed_asset, "300000");
  await f.expectBalance(f.system.payable, "-300000");
  const report = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-31",
  );
  assert.equal(report.summary.expenses, "0.00");
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
  assert.equal(
    (
      await connection.query(
        "SELECT count(*)::int n FROM assets WHERE document_id=$1",
        [asset.id],
      )
    ).rows[0].n,
    1,
  );
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

test("pending records stay unposted and period locks and account ownership prevent partial ledger writes", async () => {
  const f = await fixture("Controls"),
    other = await fixture("Other company");
  const d = await f.draft({
    kind: "receipt",
    targetId: f.bank,
    headId: f.system.revenue,
  });
  assert.equal(d.status, "pending");
  await f.expectBalance(f.bank, "0");
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

test("new capital bills and project links are rejected while retained capital liabilities remain payable", async () => {
  const f = await fixture("Retired capital bills");
  const capitalCategory = (
    await connection.query(
      "INSERT INTO categories(company_id,name,account_id) VALUES($1,'Retained capital category',$2) RETURNING id",
      [f.company.id, f.system.fixed_asset],
    )
  ).rows[0].id;
  for (const headId of [undefined, f.system.office]) {
    await assert.rejects(
      () =>
        f.draft({
          kind: "bill",
          contactId: f.vendor,
          categoryId: capitalCategory,
          headId,
        }),
      /fixed asset|capital/i,
      "A capital category takes precedence over an absent or operating expense head",
    );
    const retained = (
      await connection.query(
        "INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,created_by,contact_id,category_id,head_id) VALUES($1,'bill','2026-10-01',100,'PKR',1,100,'Retained category-only capital bill',$2,$3,$4,$5) RETURNING id",
        [f.company.id, userId, f.vendor, capitalCategory, headId ?? null],
      )
    ).rows[0];
    await assert.rejects(
      () => tx((c) => postDocument(c, f.company.id, userId, retained.id)),
      /fixed asset|capital/i,
    );
    assert.equal(
      (
        await connection.query(
          "SELECT count(*) FROM journals WHERE document_id=$1",
          [retained.id],
        )
      ).rows[0].count,
      0,
    );
  }
  await assert.rejects(
    () =>
      f.draft({
        kind: "bill",
        amount: "300000",
        contactId: f.vendor,
        headId: f.system.fixed_asset,
        assetName: "New asset",
        usefulLife: 36,
      }),
    /unavailable|removed|retired|supported|capital|fixed assets/i,
  );
  await assert.rejects(
    () =>
      f.draft({
        kind: "bill",
        contactId: f.vendor,
        headId: f.system.fixed_asset,
      }),
    /fixed asset|capital/i,
  );
  await assert.rejects(
    () =>
      f.draft({
        kind: "expense",
        sourceId: f.bank,
        headId: f.system.office,
        projectId: 999,
      }),
    /project/i,
  );
  const bill = await historicalPosting(
    f,
    "bill",
    f.system.fixed_asset,
    f.system.payable,
    "300000",
    f.vendor,
  );
  await connection.query(
    "INSERT INTO assets(company_id,document_id,name,cost,salvage,useful_life,acquired) VALUES($1,$2,'Legacy capital bill',300000,0,36,'2026-10-01')",
    [f.company.id, bill.id],
  );
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
    relatedId: bill.id,
  });
  const report = await reports(
    connection,
    f.company.id,
    "2026-10-01",
    "2026-10-31",
  );
  assert.equal(
    report.cashFlow.find((row: any) => row.name === "Investing")?.balance,
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
