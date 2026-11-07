import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import Decimal from "decimal.js";
import { SortHeader } from "./SortHeader";
import { SearchableSelect } from "./SearchableSelect";
import {
  nextSort,
  sortRows,
  type SortState,
  type SortType,
  type SortValue,
} from "./tableSort";

type Row = Record<string, any>;
type Data = {
  company: Row;
  accounts: Row[];
  contacts: Row[];
  categories: Row[];
};
type Actor = { id: number; role: string; dataScope: "own" | "company" };
type BulkResult = {
  results: {
    id: number;
    status: "posted" | "already_posted" | "failed";
    message?: string;
  }[];
  posted: number;
  alreadyPosted: number;
  failed: number;
};
type Column = {
  id: string;
  label: string;
  numeric?: boolean;
  value: (row: Row) => string;
  sortValue?: (row: Row) => SortValue;
  sortType?: SortType;
};
const RETIRED_KINDS = new Set([
  "advance",
  "advance_expense",
  "advance_return",
  "asset_purchase",
  "depreciation",
]);
const MAX_SELECTED = 100;
const label = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const date = (value: string) =>
  value
    ? new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
const timestamp = (value: string) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        timeZone: "Asia/Karachi",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const amount = (value: any) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-PK", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(Number(value));
const outstandingAmount = (row: Row) =>
  row.status === "posted" &&
  (["bill", "invoice"].includes(row.kind) ||
    (row.kind === "asset_purchase" && !row.source_id)) &&
  !row.inbound
    ? Decimal.max(
        0,
        new Decimal(row.amount).minus(row.allocated || 0),
      ).toString()
    : null;

export function Transactions({
  rows,
  query,
  setQuery,
  onSelect,
  can,
  data,
  companies,
  user,
  companyId,
  loading,
  base,
  onReload,
  request,
  exportRows,
  kindLabels,
  ConfirmationModal,
}: {
  rows: Row[];
  query: string;
  setQuery: (value: string) => void;
  onSelect: (row: Row) => void;
  can: (permission: string) => boolean;
  data: Data;
  companies: Row[];
  user: Actor;
  companyId: number;
  loading: boolean;
  base: string;
  onReload: () => void;
  request: (url: string, method?: string, body?: any) => Promise<any>;
  exportRows: (name: string, rows: Row[]) => void;
  kindLabels: Record<string, string>;
  ConfirmationModal: ComponentType<{
    title: string;
    description?: string;
    children: ReactNode;
    onClose: () => void;
    busy?: boolean;
  }>;
}) {
  const [status, setStatus] = useState("pending");
  const [kind, setKind] = useState("");
  const [columnQuery, setColumnQuery] = useState("");
  const [sort, setSort] = useState<SortState>({
    key: "date",
    direction: "desc",
  });
  const [selected, setSelected] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [error, setError] = useState("");
  const storageKey = `gss-finance-transaction-columns-v1-${user.id}`;
  const account = (id: number | null) => data.accounts.find((a) => a.id === id);
  const category = (row: Row) =>
    data.categories.find((c) => c.id === row.category_id);
  const categoryName = (row: Row) => {
    const child = category(row);
    if (!child) return "—";
    const parent = data.categories.find((c) => c.id === child.parent_id);
    return parent ? `${parent.name} / ${child.name}` : child.name;
  };
  const contactName = (row: Row) =>
    row.contact_name ||
    data.contacts.find((c) => c.id === row.contact_id)?.name ||
    "—";
  const custodianName = (row: Row) => {
    const ids = [
      account(row.source_id)?.custodian_id,
      account(row.target_id)?.custodian_id,
    ].filter(Boolean);
    return (
      [...new Set(ids)]
        .map((id) => data.contacts.find((c) => c.id === id)?.name)
        .filter(Boolean)
        .join(" → ") || "—"
    );
  };
  // Resolve only names supplied by the current user's scoped bootstrap response.
  const columns: Column[] = [
    {
      id: "id",
      label: "ID",
      value: (r) => `#${String(r.id).padStart(5, "0")}`,
      sortValue: (r) => r.id,
      sortType: "number",
    },
    {
      id: "date",
      label: "Date",
      value: (r) => date(r.date),
      sortValue: (r) => r.date,
      sortType: "date",
    },
    {
      id: "description",
      label: "Description / notes",
      value: (r) => r.description || "—",
    },
    { id: "status", label: "Status", value: (r) => label(r.status) },
    {
      id: "amount",
      label: "Amount",
      numeric: true,
      value: (r) => amount(r.amount),
      sortValue: (r) => r.amount,
      sortType: "number",
    },
    { id: "currency", label: "Currency", value: (r) => r.currency || "—" },
    {
      id: "type",
      label: "Business action",
      value: (r) =>
        `${kindLabels[r.kind] || label(r.kind)}${r.inbound ? " · Incoming" : ""}`,
    },
    { id: "reference", label: "Reference", value: (r) => r.reference || "—" },
    { id: "contact", label: "Client / vendor", value: contactName },
    {
      id: "source",
      label: "Paid from / source",
      value: (r) => account(r.source_id)?.name || "—",
    },
    {
      id: "target",
      label: "Receiving account",
      value: (r) => account(r.target_id)?.name || "—",
    },
    { id: "category", label: "Category", value: categoryName },
    {
      id: "head",
      label: "Accounting head",
      value: (r) => account(category(r)?.account_id || r.head_id)?.name || "—",
    },
    {
      id: "rate",
      label: "PKR exchange rate",
      numeric: true,
      value: (r) =>
        r.rate == null
          ? "—"
          : new Intl.NumberFormat("en-PK", { maximumFractionDigits: 8 }).format(
              Number(r.rate),
            ),
      sortValue: (r) => r.rate,
      sortType: "number",
    },
    {
      id: "base",
      label: "Amount in PKR",
      numeric: true,
      value: (r) => amount(r.base_amount),
      sortValue: (r) => r.base_amount,
      sortType: "number",
    },
    { id: "custodian", label: "Cash custodian", value: custodianName },
    {
      id: "due",
      label: "Due date",
      value: (r) => date(r.due_date),
      sortValue: (r) => r.due_date,
      sortType: "date",
    },
    {
      id: "outstanding",
      label: "Outstanding",
      numeric: true,
      value: (r) => amount(outstandingAmount(r)),
      sortValue: outstandingAmount,
      sortType: "number",
    },
    { id: "creator", label: "Created by", value: (r) => r.creator || "—" },
    {
      id: "created",
      label: "Created at (PKT)",
      value: (r) => timestamp(r.created_at),
      sortValue: (r) => r.created_at,
      sortType: "date",
    },
    {
      id: "posted",
      label: "Posted at (PKT)",
      value: (r) => timestamp(r.posted_at),
      sortValue: (r) => r.posted_at,
      sortType: "date",
    },
    {
      id: "peer",
      label: "Other company",
      value: (r) =>
        companies.find(
          (c) => c.id === (r.inbound ? r.company_id : r.other_company_id),
        )?.name || "—",
    },
    {
      id: "attachments",
      label: "Attachments",
      numeric: true,
      value: (r) =>
        r.attachment_count == null ? "—" : String(r.attachment_count),
      sortValue: (r) => r.attachment_count,
      sortType: "number",
    },
  ];
  const [visibleIds, setVisibleIds] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (Array.isArray(stored)) {
        const valid = columns
          .filter((c) => stored.includes(c.id))
          .map((c) => c.id);
        if (valid.length) return valid;
      }
    } catch {
      /* Column preferences are optional. */
    }
    return columns.map((c) => c.id);
  });
  const visibleColumns = columns.filter((c) => visibleIds.includes(c.id));
  const fallbackSort: SortState = visibleIds.includes("date")
    ? { key: "date", direction: "desc" }
    : { key: visibleColumns[0].id, direction: "asc" };
  const activeSort = visibleIds.includes(sort.key) ? sort : fallbackSort;
  const sortColumn = columns.find((c) => c.id === activeSort.key)!;
  const saveColumns = (ids: string[]) => {
    setVisibleIds(ids);
    if (!ids.includes(activeSort.key))
      setSort(
        ids.includes("date")
          ? { key: "date", direction: "desc" }
          : {
              key: columns.find((c) => ids.includes(c.id))!.id,
              direction: "asc",
            },
      );
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      /* Table still works without storage. */
    }
  };
  const filtered = sortRows(
    // Keep equal values deterministic when the list is refreshed.
    sortRows(
      rows.filter(
        (r) =>
          (status === "all" || r.status === status) &&
          (!kind || r.kind === kind),
      ),
      (r) => r.id,
      "desc",
      "number",
    ),
    sortColumn.sortValue || sortColumn.value,
    activeSort.direction,
    sortColumn.sortType,
  );
  const canPost = can("transactions.post");
  const withinOwnScope = (row: Row) => {
    if (user.dataScope !== "own") return true;
    if (
      row.can_manage !== true ||
      !["expense", "transfer"].includes(row.kind) ||
      row.other_company_id ||
      row.related_id ||
      account(row.source_id)?.purpose !== "cash"
    )
      return false;
    if (
      (row.target_id || row.kind === "transfer") &&
      account(row.target_id)?.purpose !== "cash"
    )
      return false;
    if (row.head_id && account(row.head_id)?.type !== "expense") return false;
    if (row.category_id && !category(row)) return false;
    if (row.contact_id && !data.contacts.some((c) => c.id === row.contact_id))
      return false;
    return true;
  };
  const isEligible = (row: Row) =>
    canPost &&
    row.status === "pending" &&
    !row.inbound &&
    !row.retired &&
    !RETIRED_KINDS.has(row.kind) &&
    withinOwnScope(row) &&
    (!row.other_company_id ||
      companies.some((c) => c.id === row.other_company_id)) &&
    (!["opening", "adjustment"].includes(row.kind) ||
      can("accounting.manage")) &&
    !(
      row.kind === "bill" &&
      account(category(row)?.account_id || row.head_id)?.purpose ===
        "fixed_asset"
    );
  const eligible = filtered.filter(isEligible);
  const eligibleKey = eligible.map((r) => r.id).join(",");
  const selectedRows = eligible.filter((r) => selected.includes(r.id));
  const selectedIds = selectedRows.map((r) => r.id);
  const selectedSet = new Set(selectedIds);
  const selectAllRows = eligible.slice(0, MAX_SELECTED);
  const allSelected =
    selectAllRows.length > 0 &&
    selectAllRows.every((r) => selectedSet.has(r.id));
  const unavailable = busy || loading || data.company.id !== companyId;
  const reviewCount = selectedRows.filter((r) =>
    /REVIEW BEFORE POSTING/i.test(r.description || ""),
  ).length;
  const selectionTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of selectedRows)
      totals.set(
        row.currency,
        (totals.get(row.currency) || 0) + Number(row.amount),
      );
    return [...totals]
      .map(([currency, total]) => `${currency} ${amount(total)}`)
      .join(" · ");
  }, [selectedRows]);
  useEffect(() => {
    setSelected([]);
    setConfirming(false);
    setResult(null);
    setError("");
  }, [query, status, kind, companyId, user.id]);
  useEffect(() => {
    const allowed = new Set(
      eligibleKey ? eligibleKey.split(",").map(Number) : [],
    );
    setSelected((current) => current.filter((id) => allowed.has(id)));
  }, [eligibleKey]);

  async function postSelected() {
    if (
      busy ||
      unavailable ||
      !selectedIds.length ||
      selectedIds.length > MAX_SELECTED
    )
      return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const outcome: BulkResult = await request(
        `${base}/documents/bulk-post`,
        "POST",
        { ids: selectedIds },
      );
      setResult(outcome);
      setSelected(
        outcome.results.filter((r) => r.status === "failed").map((r) => r.id),
      );
    } catch (e) {
      setError(
        `${(e as Error).message} Results could not be confirmed. The list will refresh before you retry; already posted transactions will not be posted again.`,
      );
    } finally {
      onReload();
      setConfirming(false);
      setBusy(false);
    }
  }

  return (
    <section className="card transactions-workspace">
      <div className="tabs">
        {["pending", "posted", "all"].map((s) => (
          <button
            key={s}
            disabled={busy}
            className={status === s ? "active" : ""}
            onClick={() => setStatus(s)}
          >
            {s === "all" ? "All history" : label(s)}
            <span>
              {rows.filter((r) => s === "all" || r.status === s).length}
            </span>
          </button>
        ))}
      </div>
      <div className="table-toolbar">
        <div className="search-input">
          <Search size={17} />
          <input
            aria-label="Search transactions"
            value={query}
            disabled={busy}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions, references, contacts…"
          />
        </div>
        <SearchableSelect
          aria-label="Transaction type"
          value={kind}
          disabled={busy}
          onChange={setKind}
          placeholder="All transaction types"
          options={[
            { value: "", label: "All transaction types" },
            ...Object.entries(kindLabels)
              .filter(([key]) => !RETIRED_KINDS.has(key))
              .map(([value, label]) => ({ value, label })),
          ]}
        />
        <details className="column-picker">
          <summary className="button secondary compact">
            <SlidersHorizontal size={16} />
            Columns
            <span>
              {visibleColumns.length} / {columns.length}
            </span>
          </summary>
          <div
            className="column-picker-panel"
            role="group"
            aria-label="Transaction columns"
          >
            <div className="column-picker-heading">
              <strong>Visible columns</strong>
              <span>Saved for your login on this browser</span>
            </div>
            <input
              className="column-picker-search"
              type="search"
              aria-label="Search columns"
              placeholder="Search columns…"
              value={columnQuery}
              onChange={(event) => setColumnQuery(event.target.value)}
            />
            <div className="column-picker-actions">
              <button
                type="button"
                className="text-button"
                onClick={() => saveColumns(columns.map((c) => c.id))}
              >
                Show all
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => saveColumns(columns.map((c) => c.id))}
              >
                Reset columns
              </button>
            </div>
            <div className="column-options">
              {sortRows(
                columns.filter((column) =>
                  column.label
                    .toLowerCase()
                    .includes(columnQuery.trim().toLowerCase()),
                ),
                (column) => column.label,
                "asc",
              ).map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={visibleIds.includes(c.id)}
                    disabled={
                      visibleIds.length === 1 && visibleIds.includes(c.id)
                    }
                    onChange={() =>
                      saveColumns(
                        visibleIds.includes(c.id)
                          ? visibleIds.filter((id) => id !== c.id)
                          : [...visibleIds, c.id],
                      )
                    }
                  />
                  {c.label}
                </label>
              ))}
              {!columns.some((column) =>
                column.label
                  .toLowerCase()
                  .includes(columnQuery.trim().toLowerCase()),
              ) && (
                <p className="column-picker-empty" role="status">
                  No matching columns
                </p>
              )}
            </div>
          </div>
        </details>
        <button
          className="button secondary compact"
          disabled={!filtered.length || busy}
          onClick={() =>
            exportRows(
              "transactions",
              filtered.map((row) =>
                Object.fromEntries(
                  visibleColumns.map((c) => [c.label, c.value(row)]),
                ),
              ),
            )
          }
        >
          <Download size={16} />
          Export visible columns
        </button>
      </div>
      {canPost && (
        <div className="bulk-toolbar">
          <div>
            <strong>{selectedRows.length} selected</strong>
            <span>
              {eligible.length} eligible pending transactions · Up to{" "}
              {MAX_SELECTED} per batch
            </span>
          </div>
          <button
            type="button"
            className="text-button"
            disabled={!selected.length || unavailable}
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
          <button
            type="button"
            className="button compact"
            disabled={!selectedRows.length || unavailable}
            onClick={() => setConfirming(true)}
          >
            <Check size={16} />
            {busy
              ? "Posting…"
              : `Post selected${selectedRows.length ? ` (${selectedRows.length})` : ""}`}
          </button>
        </div>
      )}
      {result && (
        <div
          className={`bulk-result ${result.failed ? "has-failures" : ""}`}
          role="status"
        >
          <strong>
            {result.posted} posted
            {result.alreadyPosted
              ? ` · ${result.alreadyPosted} already posted`
              : ""}
            {result.failed ? ` · ${result.failed} could not be posted` : ""}
          </strong>
          {result.failed > 0 && (
            <>
              <p>
                Successful entries are posted. Review the failed entries below,
                then retry the remaining selection.
              </p>
              <ul>
                {result.results
                  .filter((r) => r.status === "failed")
                  .map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => {
                          const row = rows.find((d) => d.id === r.id);
                          if (row) onSelect(row);
                        }}
                      >
                        #{String(r.id).padStart(5, "0")}
                      </button>
                      <span>
                        {r.message || "This transaction could not be posted."}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          <CircleAlert size={17} />
          {error}
        </div>
      )}
      {filtered.length ? (
        <div
          className="table-scroll transactions-grid"
          tabIndex={0}
          aria-label="Transaction details; scroll horizontally to see more columns"
        >
          <table>
            <thead>
              <tr>
                {canPost && (
                  <th className="transaction-select">
                    <input
                      type="checkbox"
                      aria-label={
                        eligible.length > MAX_SELECTED
                          ? `Select first ${MAX_SELECTED} eligible transactions`
                          : "Select all eligible visible transactions"
                      }
                      checked={allSelected}
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            selectedRows.length > 0 && !allSelected;
                      }}
                      disabled={!eligible.length || unavailable}
                      onChange={() =>
                        setSelected(
                          allSelected ? [] : selectAllRows.map((r) => r.id),
                        )
                      }
                    />
                  </th>
                )}
                {visibleColumns.map((c) => (
                  <SortHeader
                    key={c.id}
                    label={c.label}
                    column={c.id}
                    sort={activeSort}
                    onSort={(key) => setSort(nextSort(activeSort, key))}
                    disabled={unavailable}
                    numeric={c.numeric}
                    className={`${c.numeric ? "align-right " : ""}${c.id === "id" ? "transaction-id" : ""}`}
                  />
                ))}
                <th className="transaction-open">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  className={
                    selectedSet.has(row.id) ? "transaction-selected" : ""
                  }
                >
                  {canPost && (
                    <td className="transaction-select">
                      <input
                        type="checkbox"
                        aria-label={`Select transaction #${String(row.id).padStart(5, "0")}`}
                        checked={selectedSet.has(row.id)}
                        disabled={
                          !isEligible(row) ||
                          unavailable ||
                          (selectedRows.length >= MAX_SELECTED &&
                            !selectedSet.has(row.id))
                        }
                        title={
                          !isEligible(row)
                            ? "Only pending transactions you can post are selectable"
                            : selectedRows.length >= MAX_SELECTED &&
                                !selectedSet.has(row.id)
                              ? "Select up to 100 transactions per batch"
                              : ""
                        }
                        onChange={() =>
                          setSelected((current) =>
                            current.includes(row.id)
                              ? current.filter((id) => id !== row.id)
                              : [...current, row.id],
                          )
                        }
                      />
                    </td>
                  )}
                  {visibleColumns.map((c) => (
                    <td
                      key={c.id}
                      className={`${c.numeric ? "align-right " : ""}${c.id === "id" ? "transaction-id" : ""}`}
                    >
                      {c.id === "status" ? (
                        <span className={`badge ${row.status}`}>
                          <span />
                          {c.value(row)}
                        </span>
                      ) : c.id === "description" ? (
                        <>
                          <button
                            type="button"
                            className="transaction-description-button"
                            disabled={busy}
                            onClick={() => onSelect(row)}
                            title={c.value(row)}
                          >
                            {c.value(row).split("\n")[0]}
                          </button>
                          {/REVIEW BEFORE POSTING/i.test(
                            row.description || "",
                          ) && (
                            <small className="transaction-review-note">
                              Review before posting
                            </small>
                          )}
                        </>
                      ) : (
                        <span
                          className="transaction-value"
                          title={c.value(row)}
                        >
                          {c.value(row)}
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="transaction-open">
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Open transaction #${String(row.id).padStart(5, "0")}`}
                      disabled={busy}
                      onClick={() => onSelect(row)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <div className="empty-icon">
            <FileText size={25} />
          </div>
          <h3>
            {query || kind
              ? "No matching transactions"
              : status === "pending"
                ? "No pending transactions"
                : status === "posted"
                  ? "No posted transactions"
                  : "No transactions yet"}
          </h3>
          <p>
            {query || kind
              ? "Try a different search or transaction type."
              : "Transactions will appear here as you record business activity."}
          </p>
        </div>
      )}
      <div className="table-bottom">
        Showing {filtered.length} transaction{filtered.length === 1 ? "" : "s"}{" "}
        · {visibleColumns.length} columns
        {` · Sorted by ${sortColumn.label} ${activeSort.direction === "asc" ? "ascending" : "descending"}`}
        {eligible.length > MAX_SELECTED && canPost
          ? ` · Select all chooses the first ${MAX_SELECTED} eligible rows`
          : ""}
      </div>
      {confirming && (
        <ConfirmationModal
          title="Post selected transactions"
          description="Posting updates account balances and records the accounting entries."
          busy={busy}
          onClose={() => !busy && setConfirming(false)}
        >
          <div className="bulk-confirmation">
            <strong>
              {selectedRows.length} transaction
              {selectedRows.length === 1 ? "" : "s"}
            </strong>
            <p>
              Total transaction amounts: {selectionTotals}. This is a selection
              total, not net cash flow.
            </p>
            {reviewCount > 0 && (
              <div className="info">
                <CircleAlert size={18} />
                <span>
                  {reviewCount} selected transaction
                  {reviewCount === 1 ? " has" : "s have"} review notes. Check
                  the amounts and classifications before posting.
                </span>
              </div>
            )}
            <p>
              Valid entries will be posted. Any failures will remain pending
              with a reason. Posted entries can be corrected through reversal.
            </p>
            {busy && (
              <p role="status">
                Posting {selectedRows.length} selected transactions…
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={unavailable || !selectedRows.length}
              onClick={() => void postSelected()}
            >
              {busy ? "Posting…" : `Post ${selectedRows.length} transactions`}
            </button>
          </div>
        </ConfirmationModal>
      )}
    </section>
  );
}
