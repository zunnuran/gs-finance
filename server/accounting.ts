import Decimal from "decimal.js";
import type { Connection } from "./db";
import {
  documentSchema,
  retiredKinds,
  type DocumentInput,
} from "../shared/domain";
Decimal.set({ precision: 40 });
export class RuleError extends Error {
  status = 400;
}
export const fail = (message: string, status = 400): never => {
  const error = new RuleError(message);
  error.status = status;
  throw error;
};
export const value = (v: Decimal.Value) => new Decimal(v).toFixed(2);
export async function assertActiveDocument(
  c: Connection,
  company: number,
  input: Partial<DocumentInput>,
  options: { allowLegacyProject?: boolean } = {},
) {
  if ((retiredKinds as readonly string[]).includes(input.kind || ""))
    fail(
      "This transaction type belongs to a removed module. Existing posted history is retained.",
      410,
    );
  if (input.projectId && !options.allowLegacyProject)
    fail("Projects are no longer managed in this app", 410);
  if (
    input.assetName !== undefined ||
    input.usefulLife !== undefined ||
    input.salvage !== undefined
  )
    fail("Fixed assets are no longer managed in this app", 410);
  // Capital bills must not bypass removal of the fixed-asset workflow.
  if (input.kind === "bill") {
    const head = (
      await c.query(
        `SELECT a.purpose FROM accounts a WHERE a.company_id=$1 AND a.id=COALESCE(
        (SELECT account_id FROM categories WHERE id=$2 AND company_id=$1),$3)`,
        [company, input.categoryId ?? null, input.headId ?? null],
      )
    ).rows[0];
    if (head?.purpose === "fixed_asset")
      fail("Fixed asset purchases are no longer managed in this app", 410);
  }
}
export async function audit(
  c: Connection,
  company: number | null,
  user: number,
  action: string,
  entity: string,
  id: number,
  before: any,
  after: any,
) {
  await c.query(
    "INSERT INTO audit(company_id,user_id,action,entity,entity_id,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      company,
      user,
      action,
      entity,
      id,
      JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
}
const templates: [string, string, string, string][] = [
  ["1000", "Accounts receivable", "asset", "receivable"],
  ["1100", "Employee advances", "asset", "advance"],
  ["1200", "Fixed assets", "asset", "fixed_asset"],
  ["1290", "Accumulated depreciation", "asset", "accum_depreciation"],
  ["1300", "Inter-company receivable", "asset", "due_from"],
  ["2000", "Accounts payable", "liability", "payable"],
  ["2100", "Loans payable", "liability", "loan"],
  ["2200", "Taxes payable", "liability", "tax"],
  ["2300", "Inter-company payable", "liability", "due_to"],
  ["3000", "Share capital", "equity", "capital"],
  ["3100", "Opening balance equity", "equity", "opening"],
  ["3200", "Retained earnings", "equity", "retained"],
  ["4000", "Game & software development", "revenue", "revenue"],
  ["4100", "Other income", "revenue", "other_income"],
  ["5000", "Office expenses", "expense", "office"],
  ["5100", "Employee expenses", "expense", "employee_expense"],
  ["5200", "Software & services", "expense", "software"],
  ["5300", "Marketing & travel", "expense", "marketing"],
  ["5400", "Bank charges", "expense", "fees"],
  ["5500", "Depreciation", "expense", "depreciation"],
  ["5600", "Exchange gain / loss", "expense", "fx"],
  ["5700", "Taxes & professional fees", "expense", "other_expense"],
];
export async function createCompany(c: Connection, user: number, name: string) {
  const company = (
    await c.query("INSERT INTO companies(name) VALUES($1) RETURNING *", [name])
  ).rows[0];
  await c.query("INSERT INTO memberships(user_id,company_id) VALUES($1,$2)", [
    user,
    company.id,
  ]);
  const ids: Record<string, number> = {};
  for (const [code, label, type, purpose] of templates)
    ids[purpose] = (
      await c.query(
        "INSERT INTO accounts(company_id,code,name,type,purpose,restricted) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
        [
          company.id,
          code,
          label,
          type,
          purpose,
          purpose === "employee_expense",
        ],
      )
    ).rows[0].id;
  for (const [name, purpose, children] of [
    [
      "Office expenses",
      "office",
      [
        "Electricity",
        "Gas",
        "Water",
        "Internet",
        "Telephone",
        "Office supplies",
        "Cleaning",
        "Maintenance",
      ],
    ],
    [
      "Employee expenses",
      "employee_expense",
      ["Salaries", "Bonuses", "Allowances", "Training", "Employee welfare"],
    ],
    [
      "Software & services",
      "software",
      [
        "Cloud services",
        "Software licenses",
        "SaaS subscriptions",
        "Domains & hosting",
        "Development tools",
      ],
    ],
    [
      "Marketing & travel",
      "marketing",
      [
        "Advertising",
        "Client meetings",
        "Events",
        "Travel",
        "Promotional expenses",
      ],
    ],
    ["Financial expenses", "fees", ["Bank charges"]],
    [
      "Taxes & professional fees",
      "other_expense",
      ["Taxes", "Legal fees", "Miscellaneous"],
    ],
  ] as [string, string, string[]][]) {
    const parent = (
      await c.query(
        "INSERT INTO categories(company_id,name,account_id) VALUES($1,$2,$3) RETURNING id",
        [company.id, name, ids[purpose]],
      )
    ).rows[0].id;
    for (let i = 0; i < children.length; i++)
      await c.query(
        "INSERT INTO categories(company_id,name,parent_id,account_id,position) VALUES($1,$2,$3,$4,$5)",
        [company.id, children[i], parent, ids[purpose], i],
      );
  }
  await audit(
    c,
    company.id,
    user,
    "create",
    "company",
    company.id,
    null,
    company,
  );
  return company;
}
export async function createDocument(
  c: Connection,
  company: number,
  user: number,
  input: unknown,
) {
  const d = documentSchema.parse(input);
  await assertActiveDocument(c, company, d);
  if (
    Number.isNaN(Date.parse(d.date)) ||
    new Date(d.date).toISOString().slice(0, 10) !== d.date
  )
    fail("Invalid transaction date");
  if (d.currency === "PKR" && !new Decimal(d.rate).eq(1))
    fail("PKR exchange rate must be 1");
  const base = value(new Decimal(d.amount).mul(d.rate));
  if (new Decimal(base).lte(0) || new Decimal(base).gte("1000000000000000000"))
    fail(
      "Converted amount must be between 0.01 and 999,999,999,999,999,999.99 PKR",
    );
  if (
    d.dueDate &&
    (Number.isNaN(Date.parse(d.dueDate)) ||
      new Date(d.dueDate).toISOString().slice(0, 10) !== d.dueDate ||
      d.dueDate < d.date)
  )
    fail("Due date must be a valid date on or after transaction date");
  const extra = {
    assetName: d.assetName,
    usefulLife: d.usefulLife,
    salvage: d.salvage,
    openingSide: d.openingSide,
    targetAmount: d.targetAmount,
    targetRate: d.targetRate,
  };
  const result = (
    await c.query(
      `INSERT INTO documents(company_id,kind,date,amount,currency,rate,base_amount,description,reference,due_date,source_id,target_id,head_id,contact_id,project_id,category_id,related_id,other_company_id,created_by,extra)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [
        company,
        d.kind,
        d.date,
        d.amount,
        d.currency,
        d.rate,
        base,
        d.description,
        d.reference,
        d.dueDate,
        d.sourceId,
        d.targetId,
        d.headId,
        d.contactId,
        d.projectId,
        d.categoryId,
        d.relatedId,
        d.otherCompanyId,
        user,
        extra,
      ],
    )
  ).rows[0];
  await audit(c, company, user, "create", "document", result.id, null, result);
  return result;
}
export async function postDocument(
  c: Connection,
  company: number,
  user: number,
  id: number,
) {
  const co = (
    await c.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [company])
  ).rows[0];
  const d = (
    await c.query(
      "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [id, company],
    )
  ).rows[0];
  if (!d) fail("Transaction not found");
  if (d.status === "posted") return d;
  if (d.status !== "pending")
    fail("Transaction cannot be posted in its current state");
  await assertActiveDocument(
    c,
    company,
    {
      kind: d.kind,
      headId: d.head_id,
      categoryId: d.category_id,
      projectId: d.project_id,
    },
    { allowLegacyProject: true },
  );
  if (co.locked_through && d.date <= co.locked_through)
    fail("This accounting period is locked");
  const accounts = (
    await c.query("SELECT * FROM accounts WHERE company_id=$1", [company])
  ).rows;
  const sys = (purpose: string) =>
    accounts.find((a) => a.purpose === purpose && a.active)?.id ??
    fail(`Missing system account: ${purpose}`);
  const account = (aid: number, types?: string[], cash = false) => {
    const a =
      accounts.find((a) => a.id === aid && a.active) ??
      fail("Select an active account belonging to this company");
    if (types && !types.includes(a.type))
      fail("Account type is not valid for this action");
    if (cash && !["bank", "cash"].includes(a.purpose))
      fail("Payment account must be bank/cash");
    if (
      ["bank", "cash"].includes(a.purpose) &&
      a.currency !== d.currency &&
      !(
        d.kind === "transfer" &&
        aid === d.target_id &&
        d.extra.targetAmount &&
        d.extra.targetRate
      )
    )
      fail("Account currency must match the transaction currency");
    return a.id;
  };
  let head = d.head_id;
  if (d.category_id) {
    const cat =
      (
        await c.query(
          "SELECT * FROM categories WHERE id=$1 AND company_id=$2 AND active",
          [d.category_id, company],
        )
      ).rows[0] ?? fail("Category is disabled");
    head = cat.account_id;
  }
  if (d.contact_id) {
    const contact =
      (
        await c.query(
          "SELECT * FROM contacts WHERE id=$1 AND company_id=$2 AND active",
          [d.contact_id, company],
        )
      ).rows[0] ?? fail("Contact is disabled");
    const expected = ["invoice", "client_payment"].includes(d.kind)
      ? "customer"
      : ["bill", "vendor_payment"].includes(d.kind) ||
          (d.kind === "asset_purchase" && !d.source_id)
        ? "vendor"
        : ["advance", "advance_expense", "advance_return"].includes(d.kind)
          ? "employee"
          : null;
    if (expected && contact.kind !== expected) fail(`Select a ${expected}`);
  } else if (
    [
      "invoice",
      "bill",
      "client_payment",
      "vendor_payment",
      "advance",
      "advance_expense",
      "advance_return",
    ].includes(d.kind)
  )
    fail("Select a contact");
  let debit: number, credit: number;
  switch (d.kind) {
    case "receipt":
      debit = account(d.target_id, ["asset"], true);
      credit = account(head, ["revenue", "equity", "liability"]);
      break;
    case "transfer":
    case "withdrawal":
      debit = account(d.target_id, ["asset"], true);
      credit = account(d.source_id, ["asset"], true);
      if (debit === credit) fail("Choose different accounts");
      if (
        d.kind === "withdrawal" &&
        !accounts.find(
          (a) => a.id === debit && a.purpose === "cash" && a.custodian_id,
        )
      )
        fail("Select a custodian cash account");
      break;
    case "expense":
      debit = account(head, ["expense"]);
      credit = account(d.source_id, ["asset"], true);
      break;
    case "bill":
      debit = account(head, ["expense", "asset"]);
      credit = sys("payable");
      break;
    case "invoice":
      debit = sys("receivable");
      credit = account(head, ["revenue"]);
      break;
    case "client_payment":
      debit = account(d.target_id, ["asset"], true);
      credit = sys("receivable");
      break;
    case "vendor_payment":
      debit = sys("payable");
      credit = account(d.source_id, ["asset"], true);
      break;
    case "advance":
      debit = sys("advance");
      credit = account(d.source_id, ["asset"], true);
      break;
    case "advance_expense":
      debit = account(head, ["expense"]);
      credit = sys("advance");
      break;
    case "advance_return":
      debit = account(d.target_id, ["asset"], true);
      credit = sys("advance");
      break;
    case "asset_purchase":
      debit = sys("fixed_asset");
      credit = d.source_id
        ? account(d.source_id, ["asset"], true)
        : sys("payable");
      if (!d.source_id && !d.contact_id)
        fail("Vendor is required for an unpaid asset");
      break;
    case "intercompany":
      debit = sys("due_from");
      credit = account(d.source_id, ["asset"], true);
      break;
    case "opening":
      if (d.extra.openingSide === "credit") {
        debit = sys("opening");
        credit = account(d.target_id);
      } else {
        debit = account(d.target_id);
        credit = sys("opening");
      }
      break;
    case "adjustment":
      debit = account(d.target_id);
      credit = account(d.source_id);
      if (debit === credit) fail("Choose different accounts");
      break;
    case "depreciation":
      fail("Use the asset depreciation action");
    default:
      fail("Unsupported transaction type");
  }
  let allocatedBase: string | null = null;
  if (
    [
      "client_payment",
      "vendor_payment",
      "advance_expense",
      "advance_return",
    ].includes(d.kind)
  ) {
    const original =
      (
        await c.query(
          "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
          [d.related_id, company],
        )
      ).rows[0] ?? fail("Select the invoice, bill, or advance being settled");
    const expected =
      d.kind === "client_payment"
        ? ["invoice"]
        : d.kind === "vendor_payment"
          ? ["bill", "asset_purchase"]
          : ["advance"];
    if (
      !expected.includes(original.kind) ||
      original.status !== "posted" ||
      original.contact_id !== d.contact_id ||
      original.currency !== d.currency ||
      (original.kind === "asset_purchase" && original.source_id)
    )
      fail(
        "Settlement must match an outstanding document, contact and currency",
      );
    if (d.date < original.date)
      fail("Settlement date cannot precede its invoice, bill or advance");
    const allocated = (
      await c.query(
        "SELECT COALESCE(sum(a.amount),0) amount,COALESCE(sum(a.base_amount),0) base FROM allocations a JOIN documents d ON d.id=a.document_id WHERE a.related_id=$1 AND d.status='posted'",
        [original.id],
      )
    ).rows[0];
    const remaining = new Decimal(original.amount).minus(allocated.amount);
    if (new Decimal(d.amount).gt(remaining))
      fail("Payment exceeds the outstanding amount");
    allocatedBase = new Decimal(d.amount).eq(remaining)
      ? value(new Decimal(original.base_amount).minus(allocated.base))
      : value(new Decimal(d.amount).mul(original.rate));
    await c.query(
      "INSERT INTO allocations(document_id,related_id,amount,base_amount) VALUES($1,$2,$3,$4)",
      [id, original.id, d.amount, allocatedBase],
    );
  }
  const journal = (
    await c.query(
      "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3) RETURNING id",
      [company, id, d.date],
    )
  ).rows[0].id;
  const add = async (
    cid: number,
    jid: number,
    aid: number,
    dr: string,
    cr: string,
    foreign: string,
    contact: number | null = d.contact_id,
    currency: string = d.currency,
  ) => {
    await c.query(
      "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,foreign_amount,currency,contact_id,project_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        jid,
        cid,
        aid,
        dr,
        cr,
        foreign,
        currency,
        contact,
        cid === company ? d.project_id : null,
      ],
    );
  };
  const settlementDebit = ["vendor_payment"].includes(d.kind);
  let dr = allocatedBase && settlementDebit ? allocatedBase : d.base_amount;
  let cr = allocatedBase && !settlementDebit ? allocatedBase : d.base_amount;
  const creditAccount = accounts.find((a) => a.id === credit!);
  const debitAccount = accounts.find((a) => a.id === debit!);
  for (const a of [debitAccount, creditAccount]) {
    if (a && ["bank", "cash"].includes(a.purpose) && a.currency !== "PKR") {
      const latest = (
        await c.query(
          "SELECT max(j.date) date FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1",
          [a.id],
        )
      ).rows[0].date;
      if (latest && d.date < latest)
        fail(
          "Foreign-currency transactions must not precede existing account activity",
        );
    }
  }
  // Foreign bank/cash outflows release average carrying cost. Restrict backdating
  // before subsequent activity so an older posting cannot change that cost basis.
  if (
    creditAccount &&
    ["bank", "cash"].includes(creditAccount.purpose) &&
    d.kind !== "opening"
  ) {
    const balance = (
      await c.query(
        "SELECT COALESCE(sum(l.foreign_amount),0) nominal,COALESCE(sum(l.debit-l.credit),0) base,max(j.date) last_date FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1",
        [credit!],
      )
    ).rows[0];
    if (new Decimal(balance.nominal).lt(d.amount))
      fail("Insufficient funds in the payment account");
    const dated = (
      await c.query(
        "SELECT COALESCE(sum(l.foreign_amount),0) nominal FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1 AND j.date<=$2",
        [credit!, d.date],
      )
    ).rows[0];
    if (new Decimal(dated.nominal).lt(d.amount))
      fail("Insufficient funds on the transaction date");
    const later = (
      await c.query(
        "SELECT min(balance) balance FROM (SELECT sum(daily) OVER(ORDER BY date) balance,date FROM (SELECT j.date,sum(l.foreign_amount) daily FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1 GROUP BY j.date) days) running WHERE date>=$2",
        [credit!, d.date],
      )
    ).rows[0];
    if (later.balance !== null && new Decimal(later.balance).lt(d.amount))
      fail("This posting would overdraw the account on a later date");
    if (creditAccount.currency !== "PKR") {
      if (balance.last_date && d.date < balance.last_date)
        fail(
          "Foreign-currency outflow must not precede existing account activity",
        );
      cr = new Decimal(balance.nominal).eq(d.amount)
        ? value(balance.base)
        : value(new Decimal(balance.base).mul(d.amount).div(balance.nominal));
      if (new Decimal(cr).lte(0))
        fail("Foreign account carrying value must be positive");
      if (
        ["transfer", "withdrawal"].includes(d.kind) &&
        debitAccount?.currency === creditAccount.currency
      )
        dr = cr;
    }
  }
  let debitForeign = d.amount,
    debitCurrency = d.currency;
  if (d.kind === "transfer" && debitAccount?.currency !== d.currency) {
    debitForeign = d.extra.targetAmount;
    debitCurrency = debitAccount!.currency;
    if (debitCurrency === "PKR" && !new Decimal(d.extra.targetRate).eq(1))
      fail("PKR target rate must be 1");
    dr = value(new Decimal(debitForeign).mul(d.extra.targetRate));
  }
  await add(
    company,
    journal,
    debit!,
    dr,
    "0",
    debitForeign,
    d.contact_id,
    debitCurrency,
  );
  await add(
    company,
    journal,
    credit!,
    "0",
    cr,
    value(new Decimal(d.amount).neg()),
  );
  const delta = new Decimal(cr).minus(dr);
  if (!delta.isZero())
    await add(
      company,
      journal,
      sys("fx"),
      delta.gt(0) ? value(delta) : "0",
      delta.lt(0) ? value(delta.neg()) : "0",
      "0",
    );
  if (d.kind === "intercompany") {
    if (!d.other_company_id || d.other_company_id === company)
      fail("Choose another company");
    const other =
      (
        await c.query("SELECT * FROM companies WHERE id=$1 FOR UPDATE", [
          d.other_company_id,
        ])
      ).rows[0] ?? fail("Company not found");
    if (other.locked_through && d.date <= other.locked_through)
      fail("Receiving company period is locked");
    const target =
      (
        await c.query(
          "SELECT * FROM accounts WHERE id=$1 AND company_id=$2 AND active AND purpose IN ('bank','cash') AND currency=$3",
          [d.target_id, other.id, d.currency],
        )
      ).rows[0] ??
      fail("Choose receiving company bank/cash in the same currency");
    const payable =
      (
        await c.query(
          "SELECT id FROM accounts WHERE company_id=$1 AND purpose='due_to' AND active",
          [other.id],
        )
      ).rows[0] ?? fail("Receiving company is missing inter-company payable");
    const jid = (
      await c.query(
        "INSERT INTO journals(company_id,document_id,date) VALUES($1,$2,$3) RETURNING id",
        [other.id, id, d.date],
      )
    ).rows[0].id;
    await add(other.id, jid, target.id, d.base_amount, "0", d.amount, null);
    await add(
      other.id,
      jid,
      payable.id,
      "0",
      d.base_amount,
      value(new Decimal(d.amount).neg()),
      null,
    );
  }
  if (
    d.kind === "asset_purchase" ||
    (d.kind === "bill" &&
      accounts.find((a) => a.id === debit)?.purpose === "fixed_asset")
  ) {
    const extra = d.extra;
    if (
      !extra.assetName ||
      !extra.usefulLife ||
      new Decimal(extra.salvage || 0).gte(d.base_amount)
    )
      fail("Provide asset name, useful life in months and salvage below cost");
    await c.query(
      "INSERT INTO assets(company_id,document_id,name,cost,salvage,useful_life,acquired) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        company,
        id,
        extra.assetName,
        d.base_amount,
        extra.salvage || 0,
        extra.usefulLife,
        d.date,
      ],
    );
  }
  const updated = (
    await c.query(
      "UPDATE documents SET status='posted',posted_at=now() WHERE id=$1 RETURNING *",
      [id],
    )
  ).rows[0];
  await audit(c, company, user, "post", "document", id, d, updated);
  return updated;
}
export async function reverseDocument(
  c: Connection,
  company: number,
  user: number,
  id: number,
  date: string,
) {
  // Lock companies in a stable order before documents, matching posting serialization.
  await c.query("SELECT id FROM companies ORDER BY id FOR UPDATE");
  const d = (
    await c.query(
      "SELECT * FROM documents WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [id, company],
    )
  ).rows[0];
  if (!d || d.status !== "posted")
    fail("Only posted transactions can be reversed");
  if (
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date < d.date
  )
    fail("Reversal date must be valid and on or after the transaction date");
  const lastSettlementReversal = (
    await c.query(
      "SELECT max(j.date) date FROM documents child JOIN journals j ON j.document_id=child.id WHERE child.related_id=$1 AND j.reversal_of IS NOT NULL",
      [id],
    )
  ).rows[0].date;
  if (lastSettlementReversal && date < lastSettlementReversal)
    fail("Reverse the original on or after its settlement reversal date");
  if (
    (
      await c.query(
        "SELECT 1 FROM allocations a JOIN documents d ON a.document_id=d.id WHERE a.related_id=$1 AND d.status='posted'",
        [id],
      )
    ).rows.length
  )
    fail("Reverse related settlements first");
  if (
    (
      await c.query(
        "SELECT 1 FROM documents WHERE related_id=$1 AND kind='depreciation' AND status='posted'",
        [id],
      )
    ).rows.length
  )
    fail("Reverse asset depreciation first");
  const js = (
    await c.query("SELECT * FROM journals WHERE document_id=$1", [id])
  ).rows;
  for (const j of js) {
    const bankLines = (
      await c.query(
        "SELECT l.*,a.currency account_currency FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE l.journal_id=$1 AND a.purpose IN ('bank','cash')",
        [j.id],
      )
    ).rows;
    for (const line of bankLines) {
      const current = (
        await c.query(
          "SELECT COALESCE(sum(l.foreign_amount),0) nominal,max(j.date) date FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1",
          [line.account_id],
        )
      ).rows[0];
      if (new Decimal(current.nominal).minus(line.foreign_amount).lt(0))
        fail("Reversal would overdraw a bank or cash account");
      if (line.account_currency !== "PKR" && current.date > date)
        fail(
          "Foreign-currency reversal must not precede existing account activity",
        );
      if (
        line.account_currency !== "PKR" &&
        (
          await c.query(
            "SELECT 1 FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN documents d ON d.id=j.document_id WHERE l.account_id=$1 AND j.id>$2 AND j.reversal_of IS NULL AND d.status='posted' LIMIT 1",
            [line.account_id, j.id],
          )
        ).rows.length
      )
        fail(
          "Reverse later foreign-currency account transactions first to preserve carrying values",
        );
      if (new Decimal(line.foreign_amount).gt(0)) {
        const atDate = (
          await c.query(
            "SELECT COALESCE(sum(l.foreign_amount),0) nominal FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account_id=$1 AND j.date<=$2",
            [line.account_id, date],
          )
        ).rows[0];
        if (new Decimal(atDate.nominal).lt(line.foreign_amount))
          fail("Reversal would overdraw the account on its date");
      }
    }
  }
  for (const j of js) {
    const co = (
      await c.query("SELECT * FROM companies WHERE id=$1", [j.company_id])
    ).rows[0];
    if (co.locked_through && date <= co.locked_through)
      fail("Reversal date is in a locked period");
    const rid = (
      await c.query(
        "INSERT INTO journals(company_id,document_id,date,reversal_of) VALUES($1,$2,$3,$4) RETURNING id",
        [j.company_id, id, date, j.id],
      )
    ).rows[0].id;
    await c.query(
      "INSERT INTO journal_lines(journal_id,company_id,account_id,debit,credit,foreign_amount,currency,contact_id,project_id) SELECT $1,company_id,account_id,credit,debit,-foreign_amount,currency,contact_id,project_id FROM journal_lines WHERE journal_id=$2",
      [rid, j.id],
    );
  }
  await c.query("UPDATE documents SET status='reversed' WHERE id=$1", [id]);
  await c.query("UPDATE assets SET active=false WHERE document_id=$1", [id]);
  await audit(c, company, user, "reverse", "document", id, d, {
    status: "reversed",
    date,
  });
}
