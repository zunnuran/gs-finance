import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import Decimal from "decimal.js";
import { SearchableSelect } from "./SearchableSelect";
import { SortHeader } from "./SortHeader";
import { nextSort, sortRows, type SortState, type SortType } from "./tableSort";
import { formatLedgerAmount } from "./TransactionLedger";
import { periodStatementRows } from "./periodStatements";
import { pakistanToday } from "../../shared/period";

type Row = Record<string, any>;
type Data = { company: Row; accounts: Row[]; contacts: Row[] };
type Column = [string, string, ("money" | "number" | "date")?];
const Exact = Decimal.clone({ precision: 40 });
const amount = (value: any) =>
  value == null || value === "" ? "—" : formatLedgerAmount(value);
const money = (value: any) =>
  value == null || value === "" ? "—" : `PKR ${amount(value)}`;
const dateLabel = (value: string) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
const total = (rows: Row[], field: string) =>
  rows.reduce((sum, row) => sum.plus(row[field] || 0), new Exact(0)).toFixed(2);
const types = [
  ["profit", "Profit & loss"],
  ["balance", "Balance sheet"],
  ["cashflow", "Cash flow"],
  ["trial", "Trial balance"],
  ["ledger", "General ledger"],
  ["journal", "Journal"],
  ["category", "Expenses by category"],
  ["employee_expenses", "Expense by employee"],
  ["employee_cash", "Cash by employee"],
  ["cash", "Cash position"],
  ["bank", "Bank statement"],
  ["receivables", "Receivables aging"],
  ["payables", "Payables aging"],
  ["contact", "Client / vendor statement"],
  ["intercompany", "Inter-company statement"],
];

export function PeriodReports({
  report,
  documents,
  data,
  to,
  from = "",
  periodLabel,
  exportRows,
}: {
  report: Row | null;
  documents: Row[];
  data: Data;
  to: string;
  from?: string;
  periodLabel?: string;
  exportRows: (name: string, rows: Row[]) => void;
}) {
  const [type, setType] = useState("profit");
  const [account, setAccount] = useState("");
  const [contact, setContact] = useState("");
  const [sort, setSort] = useState<SortState | null>(null);
  useEffect(() => {
    setAccount("");
    setContact("");
    setSort(null);
  }, [data.company.id]);
  useEffect(() => setSort(null), [from, to, periodLabel]);
  if (!report)
    return (
      <div className="card">
        <div className="empty-state">
          <h3>Reports are loading</h3>
          <p>Your posted accounting records will appear here.</p>
        </div>
      </div>
    );

  const allData = report.period?.mode === "all";
  const periodMode = !!report.period && !allData;
  const periodFrom = report.period?.from || from;
  const periodTo = report.period?.to || to;
  const periodName =
    report.period?.label ||
    periodLabel ||
    `${dateLabel(periodFrom)} — ${dateLabel(periodTo)}`;
  const reportName = types.find(([key]) => key === type)?.[1] || type;
  const statement =
    (periodMode || allData) && ["ledger", "bank", "contact"].includes(type);
  const balanceReport = ["balance", "receivables", "payables"].includes(type);
  const allDataBalanceReport = [
    "balance",
    "receivables",
    "payables",
    "trial",
    "employee_cash",
    "cash",
    "intercompany",
  ].includes(type);
  let rows: Row[] = [];
  let columns: Column[] = [
    ["name", "Account"],
    ["debit", "Debit", "money"],
    ["credit", "Credit", "money"],
    ["balance", "Balance", "money"],
  ];
  if (type === "profit") {
    rows = (report.activity || [])
      .filter((row: Row) => ["revenue", "expense"].includes(row.type))
      .map((row: Row) => ({
        ...row,
        amount: new Exact(row.balance)
          .times(row.type === "revenue" ? -1 : 1)
          .toFixed(2),
      }));
    columns = [
      ["name", "Account"],
      ["type", "Type"],
      ["amount", "Amount", "money"],
    ];
  } else if (type === "balance") {
    rows = [
      ...(report.balanceSheet?.assets || []),
      ...(report.balanceSheet?.liabilities || []),
      ...(report.balanceSheet?.equity || []),
    ].map((row) => ({
      ...row,
      balance: new Exact(row.balance)
        .times(row.type === "asset" ? 1 : -1)
        .toFixed(2),
    }));
    rows.push({
      id: "earnings",
      summary_kind: "closing",
      name: "Current retained earnings",
      type: "equity",
      balance: report.balanceSheet?.earnings || "0.00",
    });
    columns = [
      ["name", "Account"],
      ["type", "Type"],
      ["balance", allData ? "Balance" : "Closing balance", "money"],
    ];
  } else if (
    (periodMode || allData) &&
    ["trial", "employee_cash", "cash", "intercompany"].includes(type)
  ) {
    rows =
      type === "employee_cash"
        ? report.balances?.custodians || []
        : type === "intercompany"
          ? report.balances?.intercompany || []
          : (report.balances?.accounts || []).filter(
              (row: Row) =>
                type !== "cash" || ["bank", "cash"].includes(row.purpose),
            );
    columns = [
      [
        "name",
        type === "employee_cash"
          ? "Custodian"
          : type === "intercompany"
            ? "Counterparty company"
            : "Account",
      ],
      ...(periodMode ? [["opening", "B/F (PKR)", "money"] as Column] : []),
      ["debit", allData ? "Total debit (PKR)" : "Period debit (PKR)", "money"],
      [
        "credit",
        allData ? "Total credit (PKR)" : "Period credit (PKR)",
        "money",
      ],
      ["closing", allData ? "Balance (PKR)" : "C/F (PKR)", "money"],
    ];
    if (rows.some((row) => row.currency && row.currency !== "PKR")) {
      columns.push(
        ["currency", "Currency"],
        ...(periodMode
          ? [["nominal_opening", "B/F in currency", "number"] as Column]
          : []),
        ["nominal_debit", "In currency debit", "number"],
        ["nominal_credit", "In currency credit", "number"],
        [
          "nominal_closing",
          allData ? "Balance in currency" : "C/F in currency",
          "number",
        ],
      );
    }
  } else if (type === "trial") rows = report.trial || [];
  else if (type === "cashflow") {
    rows = report.cashFlow || [];
    columns = [
      ["name", "Cash flow"],
      ["debit", "Cash in", "money"],
      ["credit", "Cash out", "money"],
      ["balance", "Net movement", "money"],
    ];
    if (periodMode) {
      const opening = new Exact(report.openingSummary?.bank || 0)
        .plus(report.openingSummary?.cash || 0)
        .toFixed(2);
      const closing = new Exact(report.summary?.bank || 0)
        .plus(report.summary?.cash || 0)
        .toFixed(2);
      rows = [
        {
          id: "opening",
          name: "B/F — bank and cash",
          balance: opening,
          summary_kind: "opening",
        },
        ...rows,
        {
          id: "closing",
          name: "C/F — bank and cash",
          balance: closing,
          summary_kind: "closing",
        },
      ];
      columns[3] = ["balance", "Movement / balance", "money"];
    }
  } else if (type === "category") rows = report.byCategory || [];
  else if (type === "employee_expenses") rows = report.expenseByEmployee || [];
  else if (type === "employee_cash") rows = report.cashByEmployee || [];
  else if (type === "cash") rows = report.cashPosition || [];
  else if (type === "intercompany") {
    rows = report.intercompany || [];
    columns = [
      ["name", "Counterparty company"],
      ["debit", "Due from movement", "money"],
      ["credit", "Due to movement", "money"],
      ["balance", "Net due from / (to)", "money"],
    ];
  } else if (["ledger", "journal", "bank", "contact"].includes(type)) {
    const matches = (row: Row) =>
      (!account || row.account_id === Number(account)) &&
      (!contact || row.contact_id === Number(contact)) &&
      (type !== "bank" || row.purpose === "bank") &&
      (type !== "contact" || ["receivable", "payable"].includes(row.purpose));
    const enrich = (row: Row) => ({
      ...row,
      contact_name:
        row.contact_name ||
        data.contacts.find((item) => item.id === row.contact_id)?.name ||
        "",
    });
    const activity = (report.ledger || []).filter(matches).map(enrich);
    rows = statement
      ? periodStatementRows(
          (report.openingLedger || []).filter(matches).map(enrich),
          activity,
          periodFrom,
          periodTo,
          type === "contact",
        )
      : activity;
    if (allData) rows = rows.filter((row) => !row.summary_kind);
    columns = [
      ["date", "Date", "date"],
      ["document_id", "Document"],
      ["account_name", "Account"],
      ["description", "Description"],
      ["contact_name", "Contact"],
      ["debit", "Debit (PKR)", "money"],
      ["credit", "Credit (PKR)", "money"],
    ];
    if (statement)
      columns.push(["running_balance", "Running balance (PKR)", "money"]);
    if (rows.some((row) => row.currency && row.currency !== "PKR")) {
      columns.push(
        ["currency", "Currency"],
        [
          statement ? "nominal_movement" : "foreign_amount",
          "Movement in currency",
          "number",
        ],
      );
      if (statement)
        columns.push(["nominal_balance", "Balance in currency", "number"]);
    }
  } else if (["receivables", "payables"].includes(type)) {
    const supplied =
      type === "receivables" ? report.agingReceivables : report.agingPayables;
    rows =
      supplied ||
      documents
        .filter(
          (row) =>
            row.status === "posted" &&
            new Exact(row.amount).gt(row.allocated || 0) &&
            (type === "receivables"
              ? row.kind === "invoice"
              : row.kind === "bill" ||
                (row.kind === "asset_purchase" && !row.source_id)),
        )
        .map((row) => {
          const days = row.due_date
            ? Math.max(
                0,
                Math.floor(
                  (Date.parse(
                    allData ? report.agingAsOf || pakistanToday() : periodTo,
                  ) -
                    Date.parse(row.due_date)) /
                    86400000,
                ),
              )
            : 0;
          return {
            ...row,
            outstanding: new Exact(row.amount)
              .minus(row.allocated || 0)
              .toFixed(2),
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
        });
    columns = [
      ["id", "Document"],
      ["contact_name", "Contact"],
      ["due_date", "Due date", "date"],
      ["currency", "Currency"],
      ["outstanding", "Outstanding in currency", "number"],
      ["bucket", "Aging"],
    ];
  }

  const sortColumn = columns.find(([key]) => key === sort?.key);
  if (sort && sortColumn) {
    const [key, , format] = sortColumn;
    const sortType: SortType =
      format === "date"
        ? "date"
        : format === "money" ||
            format === "number" ||
            ["id", "document_id"].includes(key)
          ? "number"
          : "text";
    const sortSection = (section: Row[]) => [
      ...section.filter((row) => row.summary_kind === "opening"),
      ...sortRows(
        section.filter((row) => !row.summary_kind),
        (row) => row[key],
        sort.direction,
        sortType,
      ),
      ...section.filter((row) => row.summary_kind === "closing"),
    ];
    if (statement) {
      const sections = new Map<string, Row[]>();
      for (const row of rows)
        sections.set(row.statement_group, [
          ...(sections.get(row.statement_group) || []),
          row,
        ]);
      rows = [...sections.values()].flatMap(sortSection);
    } else rows = sortSection(rows);
  }

  const exportReport = () => {
    const exported: Row[] = rows.map((row) => ({
      Company: data.company.name,
      Report: reportName,
      Period: periodName,
      ...(allData ? {} : { From: periodFrom, Through: periodTo }),
      "Base currency": "PKR",
      ...Object.fromEntries(
        columns.map(([key, heading]) => [heading, row[key] ?? ""]),
      ),
    }));
    if (type === "profit")
      exported.push({
        Company: data.company.name,
        Report: reportName,
        Period: periodName,
        ...(allData ? {} : { From: periodFrom, Through: periodTo }),
        "Base currency": "PKR",
        Account: "Net profit / loss",
        Amount: report.summary?.profit || "0.00",
      });
    exportRows(
      allData
        ? `${reportName}-all-data`
        : `${reportName}-${periodFrom}-${periodTo}`,
      exported,
    );
  };
  return (
    <section className="card">
      <div className="report-toolbar">
        <SearchableSelect
          aria-label="Report"
          value={type}
          onChange={(value) => {
            setType(value);
            setAccount("");
            setContact("");
            setSort(null);
          }}
          options={types.map(([value, label]) => ({ value, label }))}
        />
        {["ledger", "bank", "journal"].includes(type) && (
          <SearchableSelect
            aria-label="Report account"
            value={account}
            onChange={(value) => {
              setAccount(value);
              setSort(null);
            }}
            options={[
              { value: "", label: "All accounts" },
              ...data.accounts
                .filter((row) => type !== "bank" || row.purpose === "bank")
                .map((row) => ({
                  value: row.id,
                  label: row.name,
                  searchText: row.code,
                })),
            ]}
          />
        )}
        {type === "contact" && (
          <SearchableSelect
            aria-label="Report contact"
            value={contact}
            onChange={(value) => {
              setContact(value);
              setSort(null);
            }}
            options={[
              { value: "", label: "All contacts" },
              ...data.contacts
                .filter((row) => ["customer", "vendor"].includes(row.kind))
                .map((row) => ({ value: row.id, label: row.name })),
            ]}
          />
        )}
        <button
          className="button secondary compact"
          disabled={!rows.length}
          onClick={exportReport}
        >
          <Download size={16} />
          Export CSV
        </button>
        <button
          className="button secondary compact"
          onClick={() => window.print()}
        >
          Print / PDF
        </button>
      </div>
      <div className="report-heading">
        <span className="eyebrow">{data.company.name}</span>
        <h2>{reportName}</h2>
        <p>
          {allData
            ? allDataBalanceReport
              ? "All recorded balances"
              : "All recorded activity"
            : balanceReport
              ? `As of ${dateLabel(periodTo)}`
              : `During selected period: ${dateLabel(periodFrom)} — ${dateLabel(periodTo)}`}{" "}
          · Base currency PKR
        </p>
        {periodMode && (
          <p>
            {periodName}
            {!balanceReport
              ? ` · Closing balances as of ${dateLabel(periodTo)}`
              : ""}
          </p>
        )}
        {periodMode &&
          ![
            "profit",
            "balance",
            "receivables",
            "payables",
            "category",
            "employee_expenses",
            "journal",
          ].includes(type) && (
            <p>
              B/F = brought forward · C/F = carried forward. Positive ledger
              balances are debit; negative balances are credit.
              {statement
                ? " Running balances follow posting-date order, even when rows are sorted."
                : ""}
            </p>
          )}
        {allData && statement && (
          <p>
            Running balances include all recorded activity in posting-date
            order.
          </p>
        )}
        {["receivables", "payables"].includes(type) && (
          <p>
            {allData
              ? `Outstanding balances include all recorded documents. Aging is measured as of ${dateLabel(report.agingAsOf || pakistanToday())}.`
              : "Outstanding balances include unpaid documents from earlier periods."}{" "}
            Amounts are shown in each document’s currency.
          </p>
        )}
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map(([key, heading, format]) => (
                  <SortHeader
                    key={key}
                    column={key}
                    label={heading}
                    sort={sort}
                    numeric={format === "money" || format === "number"}
                    onSort={(key) =>
                      setSort((current) => nextSort(current, key))
                    }
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={`${row.statement_group || ""}-${row.id || ""}-${index}`}
                  className={row.summary_kind ? "statement-summary" : ""}
                >
                  {columns.map(([key, , format]) => (
                    <td
                      key={key}
                      className={
                        format === "money" || format === "number"
                          ? "align-right amount"
                          : ""
                      }
                    >
                      {row.summary_kind ? (
                        <strong>
                          {format === "money"
                            ? money(row[key])
                            : format === "number"
                              ? amount(row[key])
                              : format === "date"
                                ? dateLabel(row[key])
                                : (row[key] ?? "—")}
                        </strong>
                      ) : format === "money" ? (
                        money(row[key])
                      ) : format === "number" ? (
                        amount(row[key])
                      ) : format === "date" ? (
                        dateLabel(row[key])
                      ) : (
                        (row[key] ?? "—")
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <h3>No activity for this report</h3>
          <p>
            {allData
              ? "Post a transaction to see it here."
              : "Try another date range or post a transaction to see it here."}
          </p>
        </div>
      )}
      {type === "profit" && (
        <div className="report-total">
          <strong>Net profit / loss</strong>
          <strong>{money(report.summary?.profit || 0)}</strong>
        </div>
      )}
      {type === "trial" && (
        <div className="report-total">
          <strong>
            {periodMode ? "Period debits / credits" : "Total debits / credits"}
          </strong>
          <span>
            {money(total(rows, "debit"))} / {money(total(rows, "credit"))}
          </span>
        </div>
      )}
    </section>
  );
}
