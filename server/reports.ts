import type { Connection } from "./db";
import Decimal from "decimal.js";
const sum = (rows: any[], get: (r: any) => Decimal.Value) =>
  rows.reduce((s, r) => s.plus(get(r)), new Decimal(0));
const net = (r: any) => new Decimal(r.debit).minus(r.credit);
export async function reports(
  c: Connection,
  company: number,
  from: string,
  to: string,
  project: number | null = null,
) {
  const rows = (
    await c.query(
      `SELECT l.*,j.date,j.document_id,j.reversal_of,a.code,a.name account_name,a.type,a.purpose,d.kind,d.description,d.reference,d.other_company_id,d.company_id origin_company_id,related.kind related_kind,EXISTS(SELECT 1 FROM assets fa WHERE fa.document_id=related.id) related_asset,ct.name contact_name,p.name project_name,CASE WHEN a.purpose='fx' THEN a.name ELSE COALESCE(cat.name,a.name) END category_name,emp.name employee_name,cust.name custodian_name,CASE WHEN d.company_id=$1 THEN peer.name ELSE origin.name END peer_name
    FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.id=l.account_id JOIN documents d ON d.id=j.document_id LEFT JOIN documents related ON related.id=d.related_id LEFT JOIN contacts ct ON ct.id=l.contact_id LEFT JOIN projects p ON p.id=l.project_id LEFT JOIN companies peer ON peer.id=d.other_company_id LEFT JOIN companies origin ON origin.id=d.company_id LEFT JOIN categories cat ON cat.id=d.category_id LEFT JOIN contacts cust ON cust.id=a.custodian_id
    LEFT JOIN contacts emp ON emp.id=COALESCE(CASE WHEN ct.kind='employee' THEN ct.id END,(SELECT ac.custodian_id FROM journal_lines jl JOIN accounts ac ON ac.id=jl.account_id WHERE jl.journal_id=j.id AND ac.purpose='cash' AND ac.custodian_id IS NOT NULL LIMIT 1))
    WHERE l.company_id=$1 AND j.date<=$2 AND ($3::integer IS NULL OR l.project_id=$3) ORDER BY j.date,j.id,l.id`,
      [company, to, project],
    )
  ).rows;
  const period = rows.filter((r) => r.date >= from);
  const group = (data: any[], key: string) => {
    const map = new Map<any, any>();
    for (const r of data) {
      const k = r[key] ?? "Unassigned";
      const entry = map.get(k) || {
        id: k,
        name: key === "account_id" ? r.account_name : k,
        code: r.code,
        type: r.type,
        purpose: r.purpose,
        debit: "0.00",
        credit: "0.00",
        balance: "0.00",
      };
      entry.debit = new Decimal(entry.debit).plus(r.debit).toFixed(2);
      entry.credit = new Decimal(entry.credit).plus(r.credit).toFixed(2);
      entry.balance = new Decimal(entry.debit).minus(entry.credit).toFixed(2);
      map.set(k, entry);
    }
    return [...map.values()];
  };
  const trial = group(rows, "account_id"),
    activity = group(period, "account_id");
  const revenue = sum(
      activity.filter((a) => a.type === "revenue"),
      (a) => a.balance,
    ).neg(),
    expenses = sum(
      activity.filter((a) => a.type === "expense"),
      (a) => a.balance,
    );
  const allProfit = sum(
    trial.filter((a) => ["revenue", "expense"].includes(a.type)),
    (a) => a.balance,
  ).neg();
  const total = (purposes: string[]) =>
    sum(
      trial.filter((a) => purposes.includes(a.purpose)),
      (a) => a.balance,
    );
  const byProject = group(
    period.filter((r) => ["revenue", "expense"].includes(r.type)),
    "project_name",
  ).map((group) => {
    const entries = period.filter(
      (r) => (r.project_name ?? "Unassigned") === group.id,
    );
    const revenue = sum(
        entries.filter((r) => r.type === "revenue"),
        net,
      ).neg(),
      expenses = sum(
        entries.filter((r) => r.type === "expense"),
        net,
      );
    return {
      ...group,
      revenue: revenue.toFixed(2),
      expenses: expenses.toFixed(2),
      profit: revenue.minus(expenses).toFixed(2),
    };
  });
  const cashLines = period.filter((l) => ["bank", "cash"].includes(l.purpose));
  const cf = group(
    cashLines.map((l) => {
      const counterparts = rows.filter(
        (x) =>
          x.journal_id === l.journal_id &&
          !["bank", "cash"].includes(x.purpose),
      );
      let cash_class = "Operating";
      if (l.kind === "opening") cash_class = "Opening balances";
      else if (l.kind === "intercompany")
        cash_class =
          l.origin_company_id === company ? "Investing" : "Financing";
      else if (
        l.kind === "asset_purchase" ||
        l.related_kind === "asset_purchase" ||
        l.related_asset ||
        counterparts.some((x) => x.purpose === "fixed_asset")
      )
        cash_class = "Investing";
      else if (
        counterparts.some((x) => x.type === "equity" || x.purpose === "loan")
      )
        cash_class = "Financing";
      else if (["transfer", "withdrawal"].includes(l.kind))
        cash_class = "Internal transfers & exchange differences";
      return { ...l, cash_class };
    }),
    "cash_class",
  );
  const openItems = (
    await c.query(
      `SELECT d.*,ct.name contact_name,COALESCE((SELECT sum(a.amount) FROM allocations a JOIN documents pay ON pay.id=a.document_id
    WHERE a.related_id=d.id AND EXISTS(SELECT 1 FROM journals j WHERE j.document_id=pay.id AND j.reversal_of IS NULL AND j.date<=$2)
    AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.document_id=pay.id AND j.reversal_of IS NOT NULL AND j.date<=$2)),0) allocated,
    COALESCE((SELECT sum(a.base_amount) FROM allocations a JOIN documents pay ON pay.id=a.document_id
    WHERE a.related_id=d.id AND EXISTS(SELECT 1 FROM journals j WHERE j.document_id=pay.id AND j.reversal_of IS NULL AND j.date<=$2)
    AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.document_id=pay.id AND j.reversal_of IS NOT NULL AND j.date<=$2)),0) allocated_base
    FROM documents d LEFT JOIN contacts ct ON ct.id=d.contact_id WHERE d.company_id=$1 AND d.kind IN ('invoice','bill','advance','asset_purchase')
    AND (d.kind<>'asset_purchase' OR d.source_id IS NULL) AND ($3::integer IS NULL OR d.project_id=$3)
    AND EXISTS(SELECT 1 FROM journals j WHERE j.document_id=d.id AND j.reversal_of IS NULL AND j.date<=$2)
    AND NOT EXISTS(SELECT 1 FROM journals j WHERE j.document_id=d.id AND j.reversal_of IS NOT NULL AND j.date<=$2) ORDER BY d.date,d.id`,
      [company, to, project],
    )
  ).rows
    .map((d) => {
      const outstanding = new Decimal(d.amount).minus(d.allocated),
        days = Math.max(
          0,
          Math.floor(
            (Date.parse(to) - Date.parse(d.due_date || d.date)) / 86400000,
          ),
        );
      return {
        ...d,
        outstanding: outstanding.toFixed(2),
        outstandingBase: new Decimal(d.base_amount)
          .minus(d.allocated_base)
          .toFixed(2),
        daysOverdue: days,
        bucket:
          days === 0
            ? "Current"
            : days <= 30
              ? "1–30 days"
              : days <= 60
                ? "31–60 days"
                : days <= 90
                  ? "61–90 days"
                  : "90+ days",
      };
    })
    .filter((d) => new Decimal(d.outstanding).gt(0));
  return {
    summary: {
      bank: total(["bank"]).toFixed(2),
      cash: total(["cash"]).toFixed(2),
      receivable: total(["receivable"]).toFixed(2),
      payable: total(["payable"]).neg().toFixed(2),
      advances: total(["advance"]).toFixed(2),
      intercompany: total(["due_from", "due_to"]).toFixed(2),
      revenue: revenue.toFixed(2),
      expenses: expenses.toFixed(2),
      profit: revenue.minus(expenses).toFixed(2),
      cashFlow: sum(cashLines, net).toFixed(2),
    },
    trial,
    activity,
    ledger: period,
    balanceSheet: {
      assets: trial.filter((a) => a.type === "asset"),
      liabilities: trial.filter((a) => a.type === "liability"),
      equity: trial.filter((a) => a.type === "equity"),
      earnings: allProfit.toFixed(2),
    },
    cashFlow: cf,
    byCategory: group(
      period.filter((r) => r.type === "expense"),
      "category_name",
    ),
    byProject,
    byEmployee: group(
      period.filter((r) => r.purpose === "advance"),
      "contact_name",
    ),
    expenseByEmployee: group(
      period.filter((r) => r.type === "expense"),
      "employee_name",
    ),
    cashByEmployee: group(
      rows.filter((r) => r.purpose === "cash"),
      "custodian_name",
    ),
    cashPosition: trial.filter((a) => ["bank", "cash"].includes(a.purpose)),
    agingReceivables: openItems.filter((d) => d.kind === "invoice"),
    agingPayables: openItems.filter((d) =>
      ["bill", "asset_purchase"].includes(d.kind),
    ),
    outstandingAdvances: openItems.filter((d) => d.kind === "advance"),
    intercompany: group(
      rows.filter((r) => ["due_from", "due_to"].includes(r.purpose)),
      "peer_name",
    ),
  };
}
