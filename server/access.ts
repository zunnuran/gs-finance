import type { Connection } from "./db";
import type { DocumentInput } from "../shared/domain";
import type { ResolvedPeriod } from "../shared/period";

type Actor = { id: number; dataScope: "own" | "company" };
export const denyScope = (): never => {
  throw Object.assign(
    new Error("This record or action is outside your data access"),
    { status: 403 },
  );
};
const ownCash = `SELECT a.id FROM accounts a JOIN user_contacts uc ON uc.company_id=a.company_id AND uc.contact_id=a.custodian_id WHERE uc.user_id=$2 AND a.company_id=$1 AND a.purpose='cash' AND NOT a.restricted`;
const ownContacts = `SELECT contact_id FROM user_contacts WHERE user_id=$2 AND company_id=$1`;
// Use the posted accounts as well as the current category mapping: remapping a
// category must never expose a historical payroll journal.
export const ownDocumentWhere = `d.company_id=$1 AND d.other_company_id IS NULL
  AND d.kind IN ('expense','capital_purchase','advance','advance_expense','advance_return','withdrawal','transfer')
  AND (d.kind<>'capital_purchase' OR d.source_id IN (${ownCash}))
  AND (d.created_by=$2 OR d.contact_id IN (${ownContacts}) OR d.source_id IN (${ownCash}) OR d.target_id IN (${ownCash}))
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE (a.id=d.head_id OR a.id=(SELECT account_id FROM categories WHERE id=d.category_id)) AND (a.restricted OR a.type='revenue'))
  AND NOT EXISTS (SELECT 1 FROM journals j JOIN journal_lines l ON l.journal_id=j.id JOIN accounts a ON a.id=l.account_id WHERE j.document_id=d.id AND (a.restricted OR a.type='revenue'))`;

export async function ownContext(c: Connection, actor: Actor, company: number) {
  const contacts = (
    await c.query(
      `SELECT contact_id FROM user_contacts WHERE user_id=$2 AND company_id=$1`,
      [company, actor.id],
    )
  ).rows.map((r) => r.contact_id as number);
  const cash = (
    await c.query(`SELECT * FROM accounts WHERE id IN (${ownCash})`, [
      company,
      actor.id,
    ])
  ).rows;
  const expenses = (
    await c.query(
      "SELECT * FROM accounts WHERE company_id=$1 AND type='expense' AND NOT restricted AND purpose NOT IN ('fx','depreciation')",
      [company],
    )
  ).rows;
  const docs = (
    await c.query(`SELECT d.* FROM documents d WHERE ${ownDocumentWhere}`, [
      company,
      actor.id,
    ])
  ).rows;
  const vendors = (
    await c.query(
      "SELECT id FROM contacts WHERE company_id=$1 AND kind='vendor'",
      [company],
    )
  ).rows.map((r) => r.id as number);
  return { contacts, cash, expenses, docs, vendors };
}

export async function assertOwnDocument(
  c: Connection,
  actor: Actor,
  company: number,
  documentId: number,
  mutate = false,
) {
  if (actor.dataScope !== "own") return;
  const d = (
    await c.query(
      `SELECT d.* FROM documents d WHERE ${ownDocumentWhere} AND d.id=$3`,
      [company, actor.id, documentId],
    )
  ).rows[0];
  if (!d || (mutate && d.created_by !== actor.id)) denyScope();
}

export function redactOwnDocument(
  d: any,
  actor: Actor,
  context: Awaited<ReturnType<typeof ownContext>>,
) {
  const cash = new Set(context.cash.map((a) => a.id));
  const contacts = new Set([...context.contacts, ...context.vendors]);
  return {
    ...d,
    source_id: cash.has(d.source_id) ? d.source_id : null,
    target_id: cash.has(d.target_id) ? d.target_id : null,
    contact_id: contacts.has(d.contact_id) ? d.contact_id : null,
    contact_name: contacts.has(d.contact_id) ? d.contact_name : null,
    created_by: d.created_by === actor.id ? actor.id : null,
    creator: d.created_by === actor.id ? d.creator : "Finance",
    approved_by: d.approved_by === actor.id ? actor.id : null,
    related_id: context.docs.some((row) => row.id === d.related_id)
      ? d.related_id
      : null,
    extra: {},
    can_manage: d.created_by === actor.id,
  };
}

export async function ownBootstrap(
  c: Connection,
  actor: Actor,
  company: number,
) {
  const context = await ownContext(c, actor, company);
  const categories = (
    await c.query(
      "SELECT * FROM categories WHERE company_id=$1 AND account_id=ANY($2::int[]) ORDER BY position,id",
      [company, context.expenses.map((a) => a.id)],
    )
  ).rows;
  const categoryIds = new Set(categories.map((r) => r.id));
  const contacts = (
    await c.query(
      "SELECT id,company_id,name,kind,active FROM contacts WHERE company_id=$1 AND (id=ANY($2::int[]) OR kind='vendor')",
      [company, context.contacts],
    )
  ).rows;
  return {
    company: (await c.query("SELECT * FROM companies WHERE id=$1", [company]))
      .rows[0],
    accounts: [...context.cash, ...context.expenses].map((a) => ({
      ...a,
      parent_id: null,
    })),
    contacts,
    projects: [],
    categories: categories.map((cat) => ({
      ...cat,
      parent_id: categoryIds.has(cat.parent_id) ? cat.parent_id : null,
    })),
  };
}

export async function ownCashBalances(
  c: Connection,
  actor: Actor,
  company: number,
  period?: Pick<ResolvedPeriod, "from" | "to"> | null,
) {
  return (
    await c.query(
      `SELECT a.id,a.name,a.name account_name,a.code,a.type,a.purpose,a.currency,
    COALESCE(sum(l.debit-l.credit),0)::text balance,
    COALESCE(sum(l.debit-l.credit),0)::text closing,
    COALESCE(sum(l.foreign_amount),0)::text nominal_balance,
    COALESCE(sum(l.foreign_amount),0)::text nominal_closing,
    COALESCE(sum(l.debit-l.credit) FILTER (WHERE j.date<$3::date),0)::text opening,
    COALESCE(sum(l.debit) FILTER (WHERE j.date>=$3::date),0)::text debit,
    COALESCE(sum(l.credit) FILTER (WHERE j.date>=$3::date),0)::text credit,
    COALESCE(sum(l.foreign_amount) FILTER (WHERE j.date<$3::date),0)::text nominal_opening,
    COALESCE(sum(GREATEST(l.foreign_amount,0)) FILTER (WHERE j.date>=$3::date),0)::text nominal_debit,
    COALESCE(sum(GREATEST(-l.foreign_amount,0)) FILTER (WHERE j.date>=$3::date),0)::text nominal_credit
    FROM accounts a LEFT JOIN (journal_lines l JOIN journals j ON j.id=l.journal_id AND j.date<=$4::date)
    ON l.account_id=a.id AND l.company_id=a.company_id
    WHERE a.id IN (${ownCash}) GROUP BY a.id ORDER BY a.id`,
      [
        company,
        actor.id,
        period?.from || "0001-01-01",
        period?.to || "9999-12-31",
      ],
    )
  ).rows;
}

export async function assertOwnInput(
  c: Connection,
  actor: Actor,
  company: number,
  d: Partial<DocumentInput>,
) {
  if (actor.dataScope !== "own") return;
  if (
    !["expense", "transfer", "capital_purchase"].includes(d.kind || "") ||
    d.otherCompanyId
  )
    denyScope();
  const data = await ownBootstrap(c, actor, company);
  const cash = new Set(
    data.accounts.filter((a) => a.purpose === "cash").map((a) => a.id),
  );
  const head = new Set(
    data.accounts.filter((a) => a.type === "expense").map((a) => a.id),
  );
  if (d.sourceId && !cash.has(d.sourceId)) denyScope();
  if (d.targetId && !cash.has(d.targetId)) denyScope();
  if (d.headId && !head.has(d.headId)) denyScope();
  if (d.categoryId && !data.categories.some((cat) => cat.id === d.categoryId))
    denyScope();
  if (d.projectId) denyScope();
  if (d.contactId && !data.contacts.some((ct) => ct.id === d.contactId))
    denyScope();
  if (d.kind === "expense" && !cash.has(d.sourceId)) denyScope();
  if (
    d.kind === "capital_purchase" &&
    (!cash.has(d.sourceId) ||
      d.targetId ||
      d.headId ||
      d.categoryId ||
      d.relatedId ||
      (d.contactId &&
        !data.contacts.some(
          (ct) => ct.id === d.contactId && ct.kind === "vendor",
        )))
  )
    denyScope();
  if (d.kind === "transfer" && (!cash.has(d.sourceId) || !cash.has(d.targetId)))
    denyScope();
  if (d.relatedId) denyScope();
}

export function documentInput(d: any): Partial<DocumentInput> {
  return {
    kind: d.kind,
    sourceId: d.source_id,
    targetId: d.target_id,
    headId: d.head_id,
    categoryId: d.category_id,
    contactId: d.contact_id,
    projectId: d.project_id,
    relatedId: d.related_id,
    otherCompanyId: d.other_company_id,
    dueDate: d.due_date,
    targetAmount: d.extra?.targetAmount,
    targetRate: d.extra?.targetRate,
    ...(d.kind === "capital_purchase"
      ? {
          assetName: d.extra?.assetName,
          usefulLife: d.extra?.usefulLife,
          salvage: d.extra?.salvage,
        }
      : {}),
  };
}
