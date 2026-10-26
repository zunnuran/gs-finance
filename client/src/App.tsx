import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowLeftRight,
  Building2,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CreditCard,
  Download,
  FileText,
  FolderKanban,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
  X,
  Check,
  Clock,
  CircleAlert,
  Package,
  Receipt,
  History,
  Paperclip,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";

type Row = Record<string, any>;
type User = {
  id: number;
  username: string;
  email: string | null;
  full_name: string;
  role: string;
  permissions: string[];
  dataScope: "own" | "company";
};
type Data = {
  company: Row;
  accounts: Row[];
  contacts: Row[];
  projects: Row[];
  categories: Row[];
};
const emptyData: Data = {
  company: {},
  accounts: [],
  contacts: [],
  projects: [],
  categories: [],
};
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const money = (v: any, currency = "PKR") =>
  new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(Number(v || 0));
const num = (v: any) =>
  new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 }).format(
    Number(v || 0),
  );
const title = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dateLabel = (s: string) =>
  s
    ? new Date(`${s.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";
const kindLabels: Record<string, string> = {
  receipt: "Receive money",
  transfer: "Transfer money",
  withdrawal: "Withdraw cash",
  expense: "Record expense",
  bill: "Record vendor bill",
  invoice: "Create client invoice",
  client_payment: "Receive client payment",
  vendor_payment: "Pay vendor",
  advance: "Issue advance",
  advance_expense: "Settle advance with expense",
  advance_return: "Return advance",
  asset_purchase: "Purchase asset",
  intercompany: "Inter-company transfer",
  opening: "Opening balance",
  adjustment: "Accounting adjustment",
  depreciation: "Depreciation",
};
async function api(url: string, method = "GET", body?: any) {
  const response = await fetch(url, {
    method,
    headers: {
      "X-GSS-Request": "1",
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ message: "The server returned an unexpected response" }));
  if (!response.ok)
    throw Object.assign(new Error(result.message || "Request failed"), {
      status: response.status,
    });
  return result;
}
function exportCSV(name: string, rows: Row[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]).filter(
    (k) => typeof rows[0][k] !== "object",
  );
  const safe = (v: any) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const csv = [
    keys.map(safe).join(","),
    ...rows.map((r) => keys.map((k) => safe(r[k])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <span />
      {title(status)}
    </span>
  );
}
function Empty({
  title: heading = "Nothing here yet",
  text = "Your records will appear here once you add them.",
  action,
}: {
  title?: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <FileText size={25} />
      </div>
      <h3>{heading}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={"field" + (wide ? " wide" : "")}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Modal({
  title: heading,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", close);
      document.body.style.overflow = old;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className={"modal" + (wide ? " modal-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <h2>{heading}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function FormShell({
  children,
  onSave,
  onClose,
  saveLabel = "Save",
  wide = false,
}: {
  children: ReactNode;
  onSave: () => Promise<void>;
  onClose: () => void;
  saveLabel?: string;
  wide?: boolean;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        setBusy(true);
        try {
          await onSave();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className={wide ? "form-grid" : "form-stack"}>{children}</div>
      {error && (
        <div className="error" role="alert">
          <CircleAlert size={17} />
          {error}
        </div>
      )}
      <div className="modal-footer">
        <button type="button" className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="button" disabled={busy}>
          {busy ? "Saving…" : saveLabel}
        </button>
      </div>
    </form>
  );
}
function Select({
  value,
  onChange,
  options,
  placeholder = "Select an option",
  required = false,
  disabled = false,
}: {
  value: any;
  onChange: (v: string) => void;
  options: Row[];
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [companies, setCompanies] = useState<Row[]>([]),
    [company, setCompany] = useState<number>(0),
    [data, setData] = useState<Data>(emptyData),
    [documents, setDocuments] = useState<Row[]>([]),
    [report, setReport] = useState<Row | null>(null),
    [page, setPage] = useState("dashboard"),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [query, setQuery] = useState(""),
    [mobile, setMobile] = useState(false),
    [from, setFrom] = useState(today().slice(0, 7) + "-01"),
    [to, setTo] = useState(today()),
    [project, setProject] = useState(""),
    [modal, setModal] = useState<Row | null>(null),
    [selected, setSelected] = useState<Row | null>(null),
    [refresh, setRefresh] = useState(0);
  const can = (p: string) => !!user?.permissions.includes(p);
  const ownData = user?.dataScope === "own";
  const base = `/api/c/${company}`;
  const notify = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 4500);
  };
  const reload = () => setRefresh((v) => v + 1);
  const initial = useCallback(async (afterLogin = false) => {
    try {
      const actor = await api("/api/auth/user");
      setUser(actor);
      if (
        actor.dataScope === "own" ||
        !actor.permissions.includes("dashboard.view")
      )
        setPage("transactions");
    } catch (error) {
      setUser(null);
      if (afterLogin) {
        if (
          error instanceof Error &&
          "status" in error &&
          error.status === 401 &&
          error.message === "Please sign in"
        )
          throw new Error(
            "Your sign-in session was not retained. Allow cookies for this site and ask your administrator to check its HTTPS and proxy settings.",
          );
        throw error;
      }
    } finally {
      setAuthLoading(false);
    }
  }, []);
  useEffect(() => {
    void initial();
  }, [initial]);
  useEffect(() => {
    if (ownData && !["transactions", "accounts", "advances"].includes(page)) {
      setPage("transactions");
      setModal(null);
      setSelected(null);
    }
  }, [ownData, page]);
  useEffect(() => {
    if (!user) return;
    api("/api/companies")
      .then((rows) => {
        setCompanies(rows);
        setCompany((c) => {
          if (rows.some((r: Row) => r.id === c)) return c;
          let saved = 0;
          try {
            saved = Number(
              localStorage.getItem(`gss-finance-company-${user.id}`),
            );
          } catch {
            /* Workspace selection still works when storage is disabled. */
          }
          return rows.some((r: Row) => r.id === saved)
            ? saved
            : rows[0]?.id || 0;
        });
      })
      .catch((e) => setError(e.message));
  }, [user, refresh]);
  const selectCompany = (id: number) => {
    setCompany(id);
    setProject("");
    setSelected(null);
    try {
      localStorage.setItem(`gss-finance-company-${user!.id}`, String(id));
    } catch {
      /* Saving a display preference is optional. */
    }
  };
  useEffect(() => {
    if (!user || !company) return;
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api(base + "/bootstrap"),
      can("transactions.view") ? api(base + "/documents") : Promise.resolve([]),
      ownData && can("transactions.view")
        ? api(base + "/my-cash").then((cash) => ({
            trial: cash,
            cashPosition: cash,
          }))
        : can("reports.view") || can("dashboard.view")
          ? api(
              `${base}/reports?from=${from}&to=${to}${project ? "&project=" + project : ""}`,
            )
          : Promise.resolve(null),
    ])
      .then(([master, docs, rep]) => {
        if (active) {
          setData(master);
          setDocuments(docs);
          setReport(rep);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [company, user, refresh, from, to, project]);
  const changePage = (next: string) => {
    setPage(next);
    setQuery("");
    setMobile(false);
    setSelected(null);
  };
  const openTransaction = (kind = "expense", prefill: Row = {}) =>
    setModal({ type: "transaction", kind, prefill });
  const closeModal = useCallback(() => setModal(null), []);
  const nav = [
    {
      label: "WORKSPACE",
      items: [
        ["dashboard", "Overview", LayoutDashboard, "dashboard.view"],
        ["transactions", "Transactions", ArrowLeftRight, "transactions.view"],
        [
          "accounts",
          ownData ? "My cash" : "Bank & cash",
          Landmark,
          "transactions.view",
        ],
      ],
    },
    {
      label: "BUSINESS",
      items: [
        [
          "receivables",
          "Clients & receivables",
          ArrowDownLeft,
          "transactions.view",
        ],
        ["payables", "Vendors & payables", ArrowUpRight, "transactions.view"],
        [
          "advances",
          ownData ? "My advances" : "People & advances",
          Users,
          "transactions.view",
        ],
        ["projects", "Projects", FolderKanban, "transactions.view"],
        ["assets", "Fixed assets", Package, "transactions.view"],
      ],
    },
    {
      label: "FINANCE",
      items: [
        ["reports", "Reports", ChartNoAxesCombined, "reports.view"],
        ["reconciliation", "Reconciliation", ShieldCheck, "accounting.manage"],
        ["categories", "Categories", Receipt, "masters.manage"],
        ["chart", "Chart of accounts", FileText, "accounting.manage"],
        ["audit", "Audit trail", History, "audit.view"],
      ],
    },
    {
      label: "ADMINISTRATION",
      items: [
        ["admin", "Users & permissions", ShieldCheck, "users.manage"],
        ["settings", "Company settings", Settings, "accounting.manage"],
      ],
    },
  ]
    .map((group) => ({
      ...group,
      items: group.items.filter(
        ([key]) =>
          !ownData ||
          ["transactions", "accounts", "advances"].includes(key as string),
      ),
    }))
    .filter((group) => group.items.length > 0);
  const pageTitles: Record<string, [string, string]> = {
    dashboard: [
      "Financial overview",
      "A clear picture of your studio’s finances.",
    ],
    transactions: [
      ownData ? "My transactions" : "Transactions",
      ownData
        ? "Your submissions and the company funds assigned to you."
        : "Manage the money moving through your business.",
    ],
    accounts: [
      ownData ? "My cash" : "Bank & cash",
      ownData
        ? "Balances for the cash accounts assigned to you."
        : "Every account. Every custodian. One clear view.",
    ],
    receivables: [
      "Clients & receivables",
      "Track client invoices, payments, and outstanding balances.",
    ],
    payables: [
      "Vendors & payables",
      "Keep supplier bills and payments organized.",
    ],
    advances: [
      ownData ? "My advances" : "People & advances",
      ownData
        ? "Track advances issued to you and record their settlement."
        : "Know who holds company funds and what is outstanding.",
    ],
    projects: [
      "Projects",
      "Connect your financial activity to the work behind it.",
    ],
    assets: ["Fixed assets", "Manage purchases and monthly depreciation."],
    reports: [
      "Financial reports",
      "Explore your company’s performance and accounting records.",
    ],
    reconciliation: [
      "Bank reconciliation",
      "Match recorded transactions to your bank statement.",
    ],
    categories: [
      "Expense categories",
      "Organize spending with categories and sub-categories.",
    ],
    chart: [
      "Chart of accounts",
      "The accounting foundation behind your business actions.",
    ],
    audit: ["Audit trail", "A record of who changed what, and when."],
    admin: ["Users & permissions", "Give your team the access they need."],
    settings: [
      "Company settings",
      "Configure approval workflows and accounting periods.",
    ],
  };
  if (authLoading)
    return (
      <div className="screen-loading">
        <div className="brand-mark">G</div>
        <p>Opening GSS Finance…</p>
      </div>
    );
  if (!user) return <Login onLogin={() => initial(true)} />;
  const totalPending = documents.filter((d) => d.status === "submitted").length;
  const filteredDocs = documents.filter(
    (d) =>
      !query ||
      [d.description, d.reference, d.contact_name, d.id, kindLabels[d.kind]]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="app-shell">
      {mobile && (
        <div className="sidebar-scrim" onClick={() => setMobile(false)} />
      )}
      <aside className={"sidebar" + (mobile ? " open" : "")}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            changePage(can("dashboard.view") ? "dashboard" : "transactions");
          }}
        >
          <span className="brand-mark">
            G<span />
          </span>
          <span>
            GSS<span className="brand-light">Finance</span>
          </span>
        </a>
        <div className="company-select">
          <div className="company-icon">
            <Building2 size={19} />
          </div>
          <div>
            <small>YOUR WORKSPACE</small>
            <select
              aria-label="Company"
              value={company || ""}
              onChange={(e) => {
                selectCompany(Number(e.target.value));
              }}
            >
              {!companies.length && (
                <option value="">Set up your company</option>
              )}
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <nav>
          {nav.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items
                .filter(([, , , perm]) => can(perm as string))
                .map(([key, label, Icon]) => {
                  const I = Icon as typeof LayoutDashboard;
                  return (
                    <button
                      key={key as string}
                      className={"nav-item" + (page === key ? " active" : "")}
                      onClick={() => changePage(key as string)}
                    >
                      <I size={18} />
                      <span>{label as string}</span>
                      {key === "transactions" && totalPending > 0 && (
                        <b className="nav-count">{totalPending}</b>
                      )}
                    </button>
                  );
                })}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={17} />
            <span>
              Balanced by design<small>Double-entry accounting</small>
            </span>
          </div>
          <button
            className="profile"
            onClick={async () => {
              await api("/api/logout", "POST");
              setUser(null);
              setCompany(0);
              setData(emptyData);
            }}
          >
            <span className="avatar">
              {user.full_name
                .split(" ")
                .map((s) => s[0])
                .slice(0, 2)
                .join("")}
            </span>
            <span title={user.email || user.username}>
              <strong>{user.full_name}</strong>
              <small>{title(user.role)}</small>
            </span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{pageTitles[page]?.[0]}</strong>
          </div>
          <div className="topbar-right">
            <span className="currency-pill">
              <span /> PKR base currency
            </span>
            <button
              className="icon-button"
              title="Refresh data"
              aria-label="Refresh data"
              onClick={reload}
            >
              <RefreshCw size={17} />
            </button>
            <span className="avatar small">{user.full_name[0]}</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {data.company.name || "WELCOME TO GSS FINANCE"}
              </div>
              <h1>{pageTitles[page]?.[0]}</h1>
              <p>{pageTitles[page]?.[1]}</p>
            </div>
            {company > 0 && can("transactions.create") && (
              <button className="button" onClick={() => openTransaction()}>
                <Plus size={17} />
                New transaction
              </button>
            )}
          </div>
          {error && (
            <div className="error" role="alert">
              <CircleAlert size={18} />
              {error}
              <button className="text-button" onClick={reload}>
                Retry
              </button>
            </div>
          )}
          {!companies.length ? (
            <div className="card onboarding">
              <div className="welcome-symbol">
                <Building2 size={36} />
              </div>
              <span className="eyebrow">LET’S GET STARTED</span>
              <h2>Your studio’s financial home</h2>
              <p>
                Create your company to set up its chart of accounts, categories,
                bank accounts, and team.
              </p>
              {can("masters.manage") ? (
                <button
                  className="button"
                  onClick={() => setModal({ type: "company" })}
                >
                  <Plus size={17} />
                  Create company
                </button>
              ) : (
                <p>Ask an administrator to grant you access to a company.</p>
              )}
              <div className="onboarding-features">
                <span>
                  <Check size={16} />
                  Business-friendly forms
                </span>
                <span>
                  <Check size={16} />
                  Built-in audit trail
                </span>
                <span>
                  <Check size={16} />
                  Multi-currency ready
                </span>
              </div>
            </div>
          ) : (
            <>
              {loading && <div className="loading-bar" />}
              {["dashboard", "reports"].includes(page) && (
                <div className="filterbar">
                  <div className="date-range">
                    <span>
                      <Clock size={15} />
                      Period
                    </span>
                    <input
                      aria-label="From date"
                      type="date"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                    />
                    <span>—</span>
                    <input
                      aria-label="To date"
                      type="date"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Project filter"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                  >
                    <option value="">All projects</option>
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <span className="filter-note">
                    Balances as of {dateLabel(to)}
                  </span>
                </div>
              )}
              {page === "dashboard" && (
                <Dashboard
                  report={report}
                  documents={documents.filter(
                    (d) =>
                      d.date >= from &&
                      d.date <= to &&
                      (!project || d.project_id === Number(project)),
                  )}
                  data={data}
                  can={can}
                  openTransaction={openTransaction}
                  onSelect={setSelected}
                  onPage={changePage}
                  from={from}
                  to={to}
                />
              )}
              {page === "transactions" && (
                <Transactions
                  rows={filteredDocs}
                  query={query}
                  setQuery={setQuery}
                  onSelect={setSelected}
                  can={can}
                  onNew={openTransaction}
                />
              )}
              {["accounts", "chart", "projects", "categories"].includes(
                page,
              ) && (
                <MasterPage
                  page={page}
                  ownData={ownData}
                  data={data}
                  report={report}
                  can={can}
                  onEdit={(table, row) =>
                    setModal({ type: "master", table, row })
                  }
                />
              )}
              {["receivables", "payables", "advances"].includes(page) && (
                <PeoplePage
                  page={page}
                  ownData={ownData}
                  documents={documents}
                  data={data}
                  can={can}
                  onEdit={(row) =>
                    setModal({ type: "master", table: "contacts", row })
                  }
                  onNew={openTransaction}
                  onSelect={setSelected}
                />
              )}
              {page === "assets" && (
                <Assets
                  base={base}
                  refresh={refresh}
                  can={can}
                  notify={notify}
                  reload={reload}
                  onNew={() => openTransaction("asset_purchase")}
                />
              )}
              {page === "reports" && (
                <Reports
                  report={report}
                  documents={documents}
                  data={data}
                  to={to}
                />
              )}
              {page === "reconciliation" && (
                <Reconciliation
                  base={base}
                  data={data}
                  notify={notify}
                  reload={reload}
                  refresh={refresh}
                />
              )}
              {page === "audit" && <Audit base={base} refresh={refresh} />}
              {page === "admin" && (
                <Admin
                  companies={companies}
                  currentUser={user}
                  notify={notify}
                  refresh={refresh}
                  reload={reload}
                />
              )}
              {page === "settings" && (
                <SettingsPage
                  data={data}
                  onNewCompany={() => setModal({ type: "company" })}
                  onSave={async (d) => {
                    await api(`/api/companies/${company}`, "PATCH", d);
                    notify("Company settings updated");
                    reload();
                  }}
                />
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              GSS Finance <span className="footer-dot">·</span> Built for your
              studio
            </span>
            <span>
              <ShieldCheck size={13} />
              Your books, in balance.
            </span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <span>
            <Check size={17} />
          </span>
          {toast}
        </div>
      )}
      {modal?.type === "company" && (
        <CompanyModal
          onClose={closeModal}
          onSave={async (name) => {
            const c = await api("/api/companies", "POST", { name });
            selectCompany(c.id);
            reload();
            closeModal();
            notify("Company created");
          }}
        />
      )}
      {modal?.type === "master" && (
        <MasterModal
          table={modal.table}
          row={modal.row}
          data={data}
          onClose={closeModal}
          onSave={async (d) => {
            await api(
              `${base}/${modal.table}${modal.row?.id ? "/" + modal.row.id : ""}`,
              modal.row?.id ? "PATCH" : "POST",
              d,
            );
            closeModal();
            reload();
            notify("Record saved");
          }}
        />
      )}
      {modal?.type === "transaction" && (
        <TransactionModal
          data={data}
          companies={companies}
          documents={documents}
          user={user}
          kind={modal.kind}
          prefill={modal.prefill}
          onClose={closeModal}
          onSave={async (d) => {
            const doc = await api(
              base + "/documents" + (modal.editId ? "/" + modal.editId : ""),
              modal.editId ? "PATCH" : "POST",
              d,
            );
            closeModal();
            reload();
            setSelected(doc);
            notify("Transaction saved as draft");
          }}
        />
      )}
      {selected && (
        <DocumentDetail
          doc={documents.find((d) => d.id === selected.id) || selected}
          data={data}
          base={base}
          user={user}
          can={can}
          onEdit={() => {
            const d = selected;
            setSelected(null);
            setModal({
              type: "transaction",
              kind: d.kind,
              editId: d.id,
              prefill: {
                kind: d.kind,
                date: d.date,
                amount: d.amount,
                currency: d.currency,
                rate: d.rate,
                description: d.description,
                reference: d.reference,
                dueDate: d.due_date,
                sourceId: d.source_id,
                targetId: d.target_id,
                headId: d.head_id,
                contactId: d.contact_id,
                projectId: d.project_id,
                categoryId: d.category_id,
                relatedId: d.related_id,
                otherCompanyId: d.other_company_id,
                ...d.extra,
              },
            });
          }}
          onClose={() => setSelected(null)}
          onAction={async (action, body) => {
            await api(
              `${base}/documents/${selected.id}/${action}`,
              "POST",
              body || {},
            );
            notify(
              action === "post"
                ? "Transaction posted"
                : `Transaction ${action === "reverse" ? "reversed" : action === "submit" ? "submitted" : action === "approve" ? "approved" : action === "reject" ? "rejected" : "cancelled"}`,
            );
            reload();
            setSelected(null);
          }}
          onSettle={(kind) => {
            setSelected(null);
            openTransaction(kind, {
              relatedId: selected.id,
              contactId: selected.contact_id,
              currency: selected.currency,
              rate: selected.rate,
              amount: String(
                Number(selected.amount) - Number(selected.allocated || 0),
              ),
              projectId: selected.project_id,
            });
          }}
        />
      )}
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-layout">
      <div className="login-story">
        <div className="brand">
          <span className="brand-mark">
            G<span />
          </span>
          <span>
            GSS<span className="brand-light">Finance</span>
          </span>
        </div>
        <div className="login-copy">
          <span className="eyebrow">LESS ADMIN. MORE CREATING.</span>
          <h1>
            Your studio’s money.
            <br />
            <em>A clearer picture.</em>
          </h1>
          <p>
            From everyday expenses to the bigger financial picture, bring your
            business into balance.
          </p>
          <div className="login-visual">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="floating-card">
              <span>
                <Wallet size={20} />
                One financial workspace
              </span>
              <div className="illustration-bars">
                {[38, 55, 46, 73, 61, 85, 100].map((h, i) => (
                  <i style={{ height: h + "%" }} key={i} />
                ))}
              </div>
              <p>Clarity in every transaction</p>
            </div>
          </div>
        </div>
        <small>GSS Finance · Game Studio Accounting</small>
      </div>
      <div className="login-form-side">
        <div className="login-form">
          <div className="eyebrow">WELCOME BACK</div>
          <h2>Sign in to your workspace</h2>
          <p>Keep your team, accounts, and projects connected.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              try {
                await api("/api/login", "POST", { username, password });
                await onLogin();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Username or email">
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Your username or email"
                required
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </Field>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button className="button full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          <div className="login-help">
            <ShieldCheck size={18} />
            <span>Need access? Contact your company administrator.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
function CompanyModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <Modal
      title="Create a company"
      description="Each company has its own accounts and financial records."
      onClose={onClose}
    >
      <FormShell
        onClose={onClose}
        onSave={() => onSave(name)}
        saveLabel="Create company"
      >
        <Field label="Company name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Game Studio Solutions"
            required
            autoFocus
          />
        </Field>
        <div className="info">
          <ShieldCheck size={18} />
          <span>
            PKR base currency, standard accounts, and expense categories will be
            set up automatically.
          </span>
        </div>
      </FormShell>
    </Modal>
  );
}

function Dashboard({
  report,
  documents,
  data,
  can,
  openTransaction,
  onSelect,
  onPage,
  from,
  to,
}: {
  report: Row | null;
  documents: Row[];
  data: Data;
  can: (p: string) => boolean;
  openTransaction: (k?: string) => void;
  onSelect: (d: Row) => void;
  onPage: (s: string) => void;
  from: string;
  to: string;
}) {
  const s = report?.summary || {},
    pending = documents.filter((d) => d.status === "submitted");
  const metrics = [
    ["Total bank balance", s.bank, Landmark, "Across company bank accounts"],
    ["Cash with custodians", s.cash, Wallet, "Company funds held in cash"],
    [
      "Accounts receivable",
      s.receivable,
      ArrowDownLeft,
      "Outstanding client balances",
    ],
    [
      "Accounts payable",
      s.payable,
      ArrowUpRight,
      "Outstanding vendor balances",
    ],
  ];
  const expenses = (report?.byCategory || [])
      .filter((r: Row) => Number(r.balance) > 0)
      .sort((a: Row, b: Row) => Number(b.balance) - Number(a.balance))
      .slice(0, 5),
    maxExpense = Math.max(...expenses.map((r: Row) => Number(r.balance)), 1);
  return (
    <>
      <div className="stats-grid">
        {metrics.map(([label, amount, Icon, sub], i) => {
          const I = Icon as typeof Landmark;
          return (
            <div
              className={"stat-card" + (i === 0 ? " featured" : "")}
              key={label as string}
            >
              <div className="stat-top">
                <span>{label as string}</span>
                <I size={19} />
              </div>
              <strong>{money(amount)}</strong>
              <small>{sub as string}</small>
            </div>
          );
        })}
      </div>
      <div className="dashboard-grid">
        <section className="card cashflow-card">
          <div className="card-heading">
            <div>
              <h2>Income & expenses</h2>
              <p>
                {dateLabel(from)} — {dateLabel(to)}
              </p>
            </div>
            <span className="muted-label">PKR</span>
          </div>
          <div className="performance-metrics">
            <div>
              <span>
                <i className="legend-dot income" />
                Income
              </span>
              <strong>{money(s.revenue)}</strong>
            </div>
            <div>
              <span>
                <i className="legend-dot expense" />
                Expenses
              </span>
              <strong>{money(s.expenses)}</strong>
            </div>
            <div>
              <span>Net profit / loss</span>
              <strong
                className={Number(s.profit) < 0 ? "negative" : "positive"}
              >
                {money(s.profit)}
              </strong>
            </div>
          </div>
          <div className="performance-chart">
            <div className="chart-grid">
              <span>
                {num(
                  Math.max(Number(s.revenue || 0), Number(s.expenses || 0), 1),
                )}
              </span>
              <span>
                {num(
                  Math.max(Number(s.revenue || 0), Number(s.expenses || 0), 1) /
                    2,
                )}
              </span>
              <span>0</span>
            </div>
            <div className="chart-columns">
              <div className="chart-column">
                <div
                  className="bar revenue-bar"
                  style={{
                    height: Math.max(
                      2,
                      (Math.max(0, Number(s.revenue || 0)) /
                        Math.max(
                          Number(s.revenue || 0),
                          Number(s.expenses || 0),
                          1,
                        )) *
                        145,
                    ),
                  }}
                />
                <span>Income</span>
              </div>
              <div className="chart-column">
                <div
                  className="bar expense-bar"
                  style={{
                    height: Math.max(
                      2,
                      (Math.max(0, Number(s.expenses || 0)) /
                        Math.max(
                          Number(s.revenue || 0),
                          Number(s.expenses || 0),
                          1,
                        )) *
                        145,
                    ),
                  }}
                />
                <span>Expenses</span>
              </div>
            </div>
          </div>
          <div className="card-footnote">
            <span>
              <ArrowLeftRight size={15} />
              Net cash movement
            </span>
            <strong>{money(s.cashFlow)}</strong>
          </div>
        </section>
        <section className="card quick-actions">
          <div className="card-heading">
            <div>
              <h2>Quick actions</h2>
              <p>Keep business moving</p>
            </div>
            <Plus size={18} />
          </div>
          {[
            [
              "receipt",
              "Receive money",
              "Record a business receipt",
              ArrowDownLeft,
            ],
            [
              "expense",
              "Record expense",
              "Capture a payment or purchase",
              Receipt,
            ],
            [
              "transfer",
              "Transfer money",
              "Move funds between accounts",
              ArrowLeftRight,
            ],
            [
              "advance",
              "Issue an advance",
              "Track money given to your team",
              Users,
            ],
          ].map(([kind, label, sub, Icon]) => {
            const I = Icon as typeof Users;
            return (
              <button
                className="quick-action"
                key={kind as string}
                disabled={!can("transactions.create")}
                onClick={() => openTransaction(kind as string)}
              >
                <span
                  className={
                    "action-icon " + (kind === "receipt" ? "brand-icon" : "")
                  }
                >
                  <I size={19} />
                </span>
                <span>
                  <strong>{label as string}</strong>
                  <small>{sub as string}</small>
                </span>
                <ChevronRight size={16} />
              </button>
            );
          })}
          <div className="pending-box">
            <span className="pending-icon">
              <Clock size={18} />
            </span>
            <div>
              <strong>{pending.length} pending approval</strong>
              <small>Review submitted transactions</small>
            </div>
            <button
              className="icon-button"
              aria-label="View pending transactions"
              onClick={() => onPage("transactions")}
            >
              <ArrowUpRight size={19} />
            </button>
          </div>
        </section>
      </div>
      <div className="dashboard-lower">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Recent transactions</h2>
              <p>The latest activity across your company</p>
            </div>
            <button
              className="text-button"
              onClick={() => onPage("transactions")}
            >
              View all
              <ArrowUpRight size={14} />
            </button>
          </div>
          <TransactionTable rows={documents.slice(0, 5)} onSelect={onSelect} />
        </section>
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Where your money goes</h2>
              <p>Expenses by account</p>
            </div>
            <ChartNoAxesCombined size={19} />
          </div>
          {expenses.length ? (
            <div className="expense-breakdown">
              {expenses.map((r: Row, i: number) => (
                <div className="expense-line" key={r.id}>
                  <div>
                    <span>
                      <i
                        style={{
                          background: [
                            "var(--chart-1)",
                            "var(--chart-2)",
                            "var(--chart-3)",
                            "var(--chart-4)",
                            "var(--chart-5)",
                          ][i],
                        }}
                      />
                      {r.name}
                    </span>
                    <strong>{money(r.balance)}</strong>
                  </div>
                  <div className="expense-track">
                    <span
                      style={{
                        width:
                          Math.max(2, (Number(r.balance) / maxExpense) * 100) +
                          "%",
                        background: [
                          "var(--chart-1)",
                          "var(--chart-2)",
                          "var(--chart-3)",
                          "var(--chart-4)",
                          "var(--chart-5)",
                        ][i],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No expenses this period"
              text="Posted expenses will appear in this breakdown."
            />
          )}
          <div className="card-footnote">
            <span>Outstanding advances</span>
            <strong>{money(s.advances)}</strong>
          </div>
        </section>
      </div>
    </>
  );
}
function TransactionTable({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect: (d: Row) => void;
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Date</th>
            <th>Status</th>
            <th className="align-right">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} onClick={() => onSelect(d)} className="clickable">
              <td>
                <div className="transaction-cell">
                  <span
                    className={
                      "transaction-icon " +
                      ([
                        "receipt",
                        "client_payment",
                        "invoice",
                        "advance_return",
                      ].includes(d.kind)
                        ? "incoming"
                        : "")
                    }
                  >
                    {[
                      "receipt",
                      "client_payment",
                      "invoice",
                      "advance_return",
                    ].includes(d.kind) ? (
                      <ArrowDownLeft size={17} />
                    ) : ["transfer", "intercompany", "withdrawal"].includes(
                        d.kind,
                      ) ? (
                      <ArrowLeftRight size={17} />
                    ) : (
                      <ArrowUpRight size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{d.description}</strong>
                    <small>
                      #{String(d.id).padStart(5, "0")} · {kindLabels[d.kind]}
                      {d.inbound ? " · Incoming" : ""}
                      {d.contact_name ? " · " + d.contact_name : ""}
                    </small>
                  </div>
                </div>
              </td>
              <td>{dateLabel(d.date)}</td>
              <td>
                <Badge status={d.status} />
              </td>
              <td className="align-right amount">
                {money(d.amount, d.currency)}
                {d.currency !== "PKR" && <small>{money(d.base_amount)}</small>}
              </td>
              <td>
                <ChevronRight size={16} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty
      title="No transactions yet"
      text="Record your first business action to start building your financial history."
    />
  );
}
function Transactions({
  rows,
  query,
  setQuery,
  onSelect,
  can,
  onNew,
}: {
  rows: Row[];
  query: string;
  setQuery: (v: string) => void;
  onSelect: (d: Row) => void;
  can: (p: string) => boolean;
  onNew: (k?: string) => void;
}) {
  const [status, setStatus] = useState("all"),
    [kind, setKind] = useState("");
  const filtered = rows.filter(
    (d) =>
      (status === "all" || d.status === status) && (!kind || d.kind === kind),
  );
  return (
    <section className="card">
      <div className="tabs">
        {["all", "draft", "submitted", "approved", "posted", "reversed"].map(
          (s) => (
            <button
              key={s}
              className={status === s ? "active" : ""}
              onClick={() => setStatus(s)}
            >
              {s === "all"
                ? "All transactions"
                : s === "submitted"
                  ? "Pending approval"
                  : title(s)}
              <span>
                {rows.filter((d) => s === "all" || d.status === s).length}
              </span>
            </button>
          ),
        )}
      </div>
      <div className="table-toolbar">
        <div className="search-input">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions, references, people…"
          />
        </div>
        <select
          aria-label="Transaction type"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All transaction types</option>
          {Object.entries(kindLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          className="button secondary compact"
          onClick={() => exportCSV("transactions", filtered)}
          disabled={!filtered.length}
        >
          <Download size={16} />
          Export
        </button>
      </div>
      <TransactionTable rows={filtered} onSelect={onSelect} />
      <div className="table-bottom">
        Showing {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
      </div>
    </section>
  );
}

function MasterPage({
  page,
  ownData = false,
  data,
  report,
  can,
  onEdit,
}: {
  page: string;
  ownData?: boolean;
  data: Data;
  report: Row | null;
  can: (p: string) => boolean;
  onEdit: (table: string, row?: Row) => void;
}) {
  const table = page === "accounts" || page === "chart" ? "accounts" : page,
    [query, setQuery] = useState("");
  const all = (data[table as keyof Data] as Row[]) || [];
  const rows = all
    .filter(
      (r) =>
        (page !== "accounts" || ["bank", "cash"].includes(r.purpose)) &&
        (!query ||
          [r.name, r.code]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) => (table === "categories" ? a.position - b.position : 0));
  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <h2>
            {page === "chart"
              ? "All accounting accounts"
              : page === "accounts"
                ? "Your money accounts"
                : title(page)}
          </h2>
          <p>
            {rows.length} records · {rows.filter((r) => r.active).length} active
          </p>
        </div>
        {can("masters.manage") && (
          <button
            className="button compact"
            onClick={() =>
              onEdit(
                table,
                page === "accounts"
                  ? { purpose: "bank", type: "asset" }
                  : undefined,
              )
            }
          >
            <Plus size={16} />
            Add{" "}
            {page === "accounts" || page === "chart"
              ? "account"
              : page === "projects"
                ? "project"
                : "category"}
          </button>
        )}
      </div>
      <div className="table-toolbar">
        <div className="search-input">
          <Search size={17} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${page === "chart" ? "accounts" : page}…`}
          />
        </div>
        <button
          className="button secondary compact"
          disabled={!rows.length}
          onClick={() => exportCSV(page, rows)}
        >
          <Download size={16} />
          Export
        </button>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                {table === "accounts" && (
                  <>
                    <th>Type</th>
                    <th>Currency</th>
                    {page === "accounts" && (
                      <th className="align-right">Balance · PKR</th>
                    )}
                  </>
                )}
                {table === "categories" && (
                  <>
                    <th>Parent category</th>
                    <th>Account</th>
                    <th>Order</th>
                  </>
                )}
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <small>
                      {r.code}
                      {r.custodian_id
                        ? " · Custodian: " +
                          (data.contacts.find((c) => c.id === r.custodian_id)
                            ?.name || "—")
                        : ""}
                    </small>
                  </td>
                  {table === "accounts" && (
                    <>
                      <td>{title(page === "accounts" ? r.purpose : r.type)}</td>
                      <td>{r.currency}</td>
                      {page === "accounts" && (
                        <td className="align-right amount">
                          {money(
                            report?.trial?.find((a: Row) => a.id === r.id)
                              ?.balance ??
                              report?.cashPosition?.find(
                                (a: Row) => a.id === r.id,
                              )?.balance ??
                              0,
                          )}
                        </td>
                      )}
                    </>
                  )}
                  {table === "categories" && (
                    <>
                      <td>
                        {data.categories.find((c) => c.id === r.parent_id)
                          ?.name || "Top level"}
                      </td>
                      <td>
                        {data.accounts.find((a) => a.id === r.account_id)?.name}
                      </td>
                      <td>{r.position}</td>
                    </>
                  )}
                  <td>
                    <Badge status={r.active ? "active" : "disabled"} />
                  </td>
                  <td>
                    {can("masters.manage") && (
                      <button
                        className="text-button"
                        onClick={() => onEdit(table, r)}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={`No ${page === "chart" ? "accounts" : page} yet`}
          text={
            ownData
              ? "Ask your finance administrator to link your employee record and assign a cash account."
              : "Add a record to start organizing your company finances."
          }
        />
      )}
    </section>
  );
}
function MasterModal({
  table,
  row,
  data,
  onClose,
  onSave,
}: {
  table: string;
  row?: Row;
  data: Data;
  onClose: () => void;
  onSave: (d: Row) => Promise<void>;
}) {
  const [form, setForm] = useState<Row>({
    name: "",
    code: "",
    type: "asset",
    currency: "PKR",
    kind: "customer",
    email: "",
    phone: "",
    tax_number: "",
    bank_details: "",
    position: 0,
    active: true,
    restricted: false,
    ...row,
    purpose:
      row?.purpose && !["general", "bank", "cash"].includes(row.purpose)
        ? "general"
        : row?.purpose || "general",
  });
  const set = (key: string, v: any) => setForm((f) => ({ ...f, [key]: v }));
  return (
    <Modal
      title={`${row?.id ? "Edit" : "Add"} ${table === "accounts" ? "account" : table === "contacts" ? form.kind : table === "projects" ? "project" : "category"}`}
      onClose={onClose}
    >
      <FormShell onClose={onClose} onSave={() => onSave(form)} wide>
        <Field label="Name" wide>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required
            autoFocus
          />
        </Field>
        {table === "accounts" && (
          <>
            <Field label="Account code">
              <input
                value={form.code}
                onChange={(e) => set("code", e.target.value)}
                required
                placeholder="e.g. 1010"
              />
            </Field>
            <Field label="Account type">
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value)}
              >
                {["asset", "liability", "equity", "revenue", "expense"].map(
                  (t) => (
                    <option key={t} value={t}>
                      {title(t)}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Account purpose">
              <select
                value={form.purpose}
                onChange={(e) => {
                  set("purpose", e.target.value);
                  if (e.target.value !== "general") set("type", "asset");
                }}
                disabled={
                  row?.purpose &&
                  !["general", "bank", "cash"].includes(row.purpose)
                }
              >
                {["general", "bank", "cash"].map((t) => (
                  <option key={t} value={t}>
                    {title(t)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Currency">
              <input
                value={form.currency}
                maxLength={3}
                pattern="[A-Z]{3}"
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
                required
              />
            </Field>
            <Field label="Cash custodian">
              <Select
                value={form.custodian_id}
                onChange={(v) => set("custodian_id", v ? Number(v) : null)}
                options={data.contacts.filter(
                  (c) => c.kind === "employee" && c.active,
                )}
                placeholder="No custodian"
              />
            </Field>
            <Field label="Parent account">
              <Select
                value={form.parent_id}
                onChange={(v) => set("parent_id", v ? Number(v) : null)}
                options={data.accounts.filter((c) => c.id !== row?.id)}
                placeholder="No parent"
              />
            </Field>
            <label className="checkbox-label wide">
              <input
                type="checkbox"
                checked={!!form.restricted}
                onChange={(e) => set("restricted", e.target.checked)}
              />
              <span>Private financial account</span>
            </label>
            <p className="subtle wide">
              Use for payroll or other sensitive accounts. Transactions using
              these accounts are hidden from users with own-data access. Income
              is always hidden from those users.
            </p>
          </>
        )}
        {table === "contacts" && (
          <>
            <Field label="Contact type">
              <select
                value={form.kind}
                onChange={(e) => set("kind", e.target.value)}
              >
                {["customer", "vendor", "employee"].map((k) => (
                  <option key={k} value={k}>
                    {title(k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <input
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </Field>
            <Field label="Tax number">
              <input
                value={form.tax_number}
                onChange={(e) => set("tax_number", e.target.value)}
              />
            </Field>
            <Field label="Bank / payment information" wide>
              <textarea
                value={form.bank_details}
                onChange={(e) => set("bank_details", e.target.value)}
              />
            </Field>
          </>
        )}
        {table === "categories" && (
          <>
            <Field label="Parent category">
              <Select
                value={form.parent_id}
                onChange={(v) => set("parent_id", v ? Number(v) : null)}
                options={data.categories.filter((c) => c.id !== row?.id)}
                placeholder="Top-level category"
              />
            </Field>
            <Field label="Display order">
              <input
                type="number"
                min="0"
                value={form.position}
                onChange={(e) => set("position", Number(e.target.value))}
              />
            </Field>
            <Field label="Accounting account" wide>
              <Select
                required
                value={form.account_id}
                onChange={(v) => set("account_id", Number(v))}
                options={data.accounts.filter(
                  (a) =>
                    a.active &&
                    (a.type === "expense" || a.purpose === "fixed_asset"),
                )}
              />
            </Field>
          </>
        )}
        <label className="checkbox-label wide">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set("active", e.target.checked)}
          />
          <span>Enabled for new transactions</span>
        </label>
      </FormShell>
    </Modal>
  );
}
function PeoplePage({
  page,
  ownData = false,
  documents,
  data,
  can,
  onEdit,
  onNew,
  onSelect,
}: {
  page: string;
  ownData?: boolean;
  documents: Row[];
  data: Data;
  can: (s: string) => boolean;
  onEdit: (r: Row) => void;
  onNew: (k?: string, p?: Row) => void;
  onSelect: (d: Row) => void;
}) {
  const [tab, setTab] = useState("open");
  const kind =
      page === "receivables"
        ? "customer"
        : page === "payables"
          ? "vendor"
          : "employee",
    docKinds =
      page === "receivables"
        ? ["invoice"]
        : page === "payables"
          ? ["bill", "asset_purchase"]
          : ["advance"];
  const rows = documents.filter(
    (d) =>
      !d.inbound &&
      docKinds.includes(d.kind) &&
      (d.kind !== "asset_purchase" || !d.source_id),
  );
  const outstanding = rows.filter(
    (d) => d.status === "posted" && Number(d.amount) > Number(d.allocated),
  );
  const people = data.contacts.filter((c) => c.kind === kind);
  const create =
    page === "receivables"
      ? "invoice"
      : page === "payables"
        ? "bill"
        : "advance";
  return (
    <>
      <div className="mini-stats">
        <div className="card">
          <span>Outstanding · PKR equivalent</span>
          <strong>
            {money(
              outstanding.reduce(
                (s, d) =>
                  s + Number(d.base_amount) - Number(d.allocated_base || 0),
                0,
              ),
            )}
          </strong>
        </div>
        <div className="card">
          <span>
            Open{" "}
            {page === "advances"
              ? "advances"
              : page === "payables"
                ? "bills"
                : "invoices"}
          </span>
          <strong>{outstanding.length}</strong>
        </div>
        <div className="card">
          <span>{title(kind)} records</span>
          <strong>{people.length}</strong>
        </div>
      </div>
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>
              {page === "advances"
                ? ownData
                  ? "My advance balances"
                  : "Employee funds"
                : page === "payables"
                  ? "Vendor balances"
                  : "Client balances"}
            </h2>
            <p>Follow each document from creation to settlement.</p>
          </div>
          {can("transactions.create") && (
            <button className="button compact" onClick={() => onNew(create)}>
              <Plus size={16} />
              {ownData && create === "advance"
                ? "Request advance"
                : kindLabels[create]}
            </button>
          )}
        </div>
        <div className="tabs">
          {[
            ["open", "Outstanding"],
            ["all", "All documents"],
            ["people", title(kind) + "s"],
          ].map(([k, label]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "people" ? (
          <>
            <div className="table-toolbar">
              <span className="subtle">{people.length} contacts</span>
              {can("masters.manage") && (
                <button
                  className="button secondary compact"
                  onClick={() => onEdit({ kind })}
                >
                  <Plus size={16} />
                  Add {kind}
                </button>
              )}
            </div>
            {people.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Phone</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                        </td>
                        <td>{c.email || "—"}</td>
                        <td>{c.phone || "—"}</td>
                        <td>
                          <Badge status={c.active ? "active" : "disabled"} />
                        </td>
                        <td>
                          {can("masters.manage") && (
                            <button
                              className="text-button"
                              onClick={() => onEdit(c)}
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={`No ${kind}s yet`}
                text={`Add your ${kind} records to use them in transactions.`}
              />
            )}
          </>
        ) : tab === "all" ? (
          <TransactionTable rows={rows} onSelect={onSelect} />
        ) : outstanding.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>{title(kind)}</th>
                  <th>Due date</th>
                  <th className="align-right">Total</th>
                  <th className="align-right">Outstanding</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {outstanding.map((d) => (
                  <tr
                    key={d.id}
                    className="clickable"
                    onClick={() => onSelect(d)}
                  >
                    <td>
                      <strong>{d.description}</strong>
                      <small>#{String(d.id).padStart(5, "0")}</small>
                    </td>
                    <td>{d.contact_name}</td>
                    <td>
                      <span
                        className={
                          d.due_date && d.due_date < today() ? "negative" : ""
                        }
                      >
                        {dateLabel(d.due_date)}
                      </span>
                    </td>
                    <td className="align-right">
                      {money(d.amount, d.currency)}
                    </td>
                    <td className="align-right amount">
                      {money(
                        Number(d.amount) - Number(d.allocated),
                        d.currency,
                      )}
                    </td>
                    <td>
                      <ChevronRight size={16} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="All clear"
            text="There are no outstanding posted documents in this company."
          />
        )}
      </section>
    </>
  );
}
function TransactionModal({
  data,
  companies,
  documents,
  user,
  kind,
  prefill = {},
  onClose,
  onSave,
}: {
  data: Data;
  companies: Row[];
  documents: Row[];
  user: User;
  kind: string;
  prefill?: Row;
  onClose: () => void;
  onSave: (d: Row) => Promise<void>;
}) {
  const [form, setForm] = useState<Row>({
      kind,
      date: today(),
      amount: "",
      currency: "PKR",
      rate: "1",
      description: "",
      reference: "",
      salvage: "0",
      usefulLife: 36,
      openingSide: "debit",
      ...prefill,
    }),
    [other, setOther] = useState<Data | null>(null),
    [otherError, setOtherError] = useState("");
  const set = (key: string, v: any) => setForm((f) => ({ ...f, [key]: v }));
  const k = form.kind;
  const ownData = user.dataScope === "own";
  useEffect(() => {
    if (!form.otherCompanyId) {
      setOther(null);
      return;
    }
    let active = true;
    setOtherError("");
    api(`/api/c/${form.otherCompanyId}/bootstrap`)
      .then((d) => {
        if (active) setOther(d);
      })
      .catch((e) => setOtherError(e.message));
    return () => {
      active = false;
    };
  }, [form.otherCompanyId]);
  const source = [
      "transfer",
      "withdrawal",
      "expense",
      "vendor_payment",
      "advance",
      "asset_purchase",
      "intercompany",
      "adjustment",
    ].includes(k),
    target = [
      "receipt",
      "transfer",
      "withdrawal",
      "client_payment",
      "advance_return",
      "intercompany",
      "opening",
      "adjustment",
    ].includes(k),
    head = [
      "receipt",
      "expense",
      "bill",
      "invoice",
      "advance_expense",
    ].includes(k),
    category = ["expense", "bill", "advance_expense"].includes(k);
  const contactKind = ["invoice", "client_payment"].includes(k)
    ? "customer"
    : ["bill", "vendor_payment", "asset_purchase"].includes(k)
      ? "vendor"
      : ["advance", "advance_expense", "advance_return"].includes(k)
        ? "employee"
        : null;
  const cash = data.accounts.filter(
    (a) => a.active && ["bank", "cash"].includes(a.purpose),
  );
  const targets =
    k === "intercompany"
      ? (other?.accounts || []).filter(
          (a) => a.active && ["bank", "cash"].includes(a.purpose),
        )
      : k === "opening" || k === "adjustment"
        ? data.accounts.filter((a) => a.active)
        : k === "withdrawal"
          ? cash.filter((a) => a.purpose === "cash" && a.custodian_id)
          : cash;
  const heads = data.accounts.filter(
    (a) =>
      a.active &&
      (k === "receipt"
        ? ["revenue", "equity", "liability"].includes(a.type)
        : k === "invoice"
          ? a.type === "revenue"
          : k === "bill"
            ? a.type === "expense" || a.purpose === "fixed_asset"
            : a.type === "expense"),
  );
  const settle = [
    "client_payment",
    "vendor_payment",
    "advance_expense",
    "advance_return",
  ].includes(k);
  const related = documents.filter(
    (d) =>
      !d.inbound &&
      d.status === "posted" &&
      Number(d.amount) > Number(d.allocated) &&
      (k === "client_payment"
        ? d.kind === "invoice"
        : k === "vendor_payment"
          ? d.kind === "bill" || (d.kind === "asset_purchase" && !d.source_id)
          : d.kind === "advance"),
  );
  const targetAccount = targets.find((a) => a.id === form.targetId);
  const cross =
    k === "transfer" &&
    targetAccount &&
    targetAccount.currency !== form.currency;
  const asset =
    k === "asset_purchase" ||
    (k === "bill" &&
      data.accounts.find(
        (a) =>
          a.id ===
          (form.categoryId
            ? data.categories.find((c) => c.id === form.categoryId)?.account_id
            : form.headId),
      )?.purpose === "fixed_asset");
  const options = Object.entries(kindLabels).filter(
    ([key]) =>
      key !== "depreciation" &&
      (ownData
        ? [
            "expense",
            "advance",
            "advance_expense",
            "advance_return",
            "transfer",
          ].includes(key)
        : user.role !== "employee" || ["expense", "advance"].includes(key)) &&
      (!["opening", "adjustment"].includes(key) ||
        user.permissions.includes("accounting.manage")),
  );
  return (
    <Modal
      title={ownData && k === "advance" ? "Request advance" : kindLabels[k]}
      description="Describe the business action. The accounting entries are created automatically."
      onClose={onClose}
      wide
    >
      <FormShell
        onClose={onClose}
        saveLabel="Save draft"
        wide
        onSave={() => {
          const payload: Row = {
            kind: k,
            date: form.date,
            amount: form.amount,
            currency: form.currency,
            rate: form.currency === "PKR" ? "1" : form.rate,
            description: form.description,
            reference: form.reference,
            projectId: form.projectId || null,
          };
          if (source) payload.sourceId = form.sourceId || null;
          if (target) payload.targetId = form.targetId || null;
          if (head) {
            payload.headId = form.headId || null;
            payload.categoryId = form.categoryId || null;
          }
          if (form.contactId) payload.contactId = form.contactId;
          if (settle) payload.relatedId = form.relatedId;
          if (["invoice", "bill"].includes(k) && form.dueDate)
            payload.dueDate = form.dueDate;
          if (k === "intercompany")
            payload.otherCompanyId = form.otherCompanyId;
          if (asset) {
            payload.assetName = form.assetName;
            payload.usefulLife = Number(form.usefulLife);
            payload.salvage = form.salvage;
          }
          if (cross) {
            payload.targetAmount = form.targetAmount;
            payload.targetRate =
              targetAccount.currency === "PKR" ? "1" : form.targetRate;
          }
          if (k === "opening") payload.openingSide = form.openingSide;
          return onSave(payload);
        }}
      >
        <Field label="Business action" wide>
          <select
            value={k}
            onChange={(e) =>
              setForm((f) => ({
                date: f.date,
                amount: "",
                currency: "PKR",
                rate: "1",
                description: "",
                reference: "",
                kind: e.target.value,
                salvage: "0",
                usefulLife: 36,
                openingSide: "debit",
              }))
            }
          >
            {options.map(([key, label]) => (
              <option key={key} value={key}>
                {ownData && key === "advance" ? "Request advance" : label}
              </option>
            ))}
          </select>
        </Field>
        {(source || target) &&
          !cash.length &&
          !["opening", "adjustment"].includes(k) && (
            <div className="info wide">
              <Landmark size={18} />
              <span>
                {ownData ? (
                  "Ask your finance administrator to link your employee record and assign your petty-cash account. You can still submit an advance request without choosing a payment account."
                ) : (
                  <>
                    Add a bank or cash account from{" "}
                    <strong>Bank &amp; cash</strong> before recording payments
                    or transfers. For cash held by an employee, add the employee
                    first, then assign them as the cash account’s custodian.
                  </>
                )}
              </span>
            </div>
          )}
        <Field label="Transaction date">
          <input
            type="date"
            value={form.date}
            onChange={(e) => set("date", e.target.value)}
            required
          />
        </Field>
        <Field label="Reference / invoice number">
          <input
            value={form.reference}
            onChange={(e) => set("reference", e.target.value)}
            placeholder="Optional reference"
          />
        </Field>
        {settle && (
          <Field label="Document to settle" wide>
            <Select
              value={form.relatedId}
              required
              options={related.map((d) => ({
                id: d.id,
                name: `#${d.id} · ${d.contact_name || ""} · ${d.description} · ${money(Number(d.amount) - Number(d.allocated), d.currency)}`,
              }))}
              onChange={(v) => {
                const doc = related.find((d) => d.id === Number(v));
                setForm((f) => ({
                  ...f,
                  relatedId: Number(v),
                  contactId: doc?.contact_id,
                  currency: doc?.currency || "PKR",
                  rate: doc?.rate || "1",
                  amount: doc
                    ? String(Number(doc.amount) - Number(doc.allocated))
                    : "",
                  projectId: doc?.project_id,
                }));
              }}
            />
          </Field>
        )}
        {k === "intercompany" && (
          <Field label="Receiving company" wide>
            <Select
              required
              value={form.otherCompanyId}
              onChange={(v) => {
                set("otherCompanyId", Number(v));
                set("targetId", null);
              }}
              options={companies.filter((c) => c.id !== data.company.id)}
            />
            {otherError && <small className="negative">{otherError}</small>}
          </Field>
        )}
        {source && (
          <Field
            label={
              k === "adjustment"
                ? "Credit account"
                : ownData && k === "advance"
                  ? "Payment account (optional)"
                  : k === "asset_purchase"
                    ? "Paid from (leave empty for vendor payable)"
                    : "Paid / transferred from"
            }
          >
            <Select
              required={k !== "asset_purchase" && !(ownData && k === "advance")}
              value={form.sourceId}
              options={
                k === "adjustment"
                  ? data.accounts.filter((a) => a.active)
                  : cash
              }
              placeholder={
                k === "asset_purchase"
                  ? "Record as vendor payable"
                  : ownData && k === "advance"
                    ? "Finance will choose the payment account"
                    : "Select source account"
              }
              onChange={(v) => {
                const a = data.accounts.find((a) => a.id === Number(v));
                set("sourceId", v ? Number(v) : null);
                if (a && k !== "adjustment") {
                  set("currency", a.currency);
                  set("rate", a.currency === "PKR" ? "1" : form.rate);
                }
              }}
            />
          </Field>
        )}
        {target && (
          <Field
            label={
              k === "withdrawal"
                ? "Cash custodian account"
                : k === "adjustment"
                  ? "Debit account"
                  : "Receiving account"
            }
          >
            <Select
              required
              value={form.targetId}
              options={targets}
              onChange={(v) => {
                const a = targets.find((a) => a.id === Number(v));
                set("targetId", Number(v));
                if (a && !source && k !== "opening") {
                  set("currency", a.currency);
                  set("rate", a.currency === "PKR" ? "1" : form.rate);
                }
                if (a && k === "opening") set("currency", a.currency);
              }}
            />
          </Field>
        )}
        <Field label="Amount">
          <input
            type="number"
            step="0.01"
            min="0.01"
            value={form.amount}
            onChange={(e) => set("amount", e.target.value)}
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Currency">
          <input
            maxLength={3}
            pattern="[A-Z]{3}"
            value={form.currency}
            onChange={(e) => set("currency", e.target.value.toUpperCase())}
            required
          />
        </Field>
        {form.currency !== "PKR" && (
          <>
            <Field
              label={`PKR per 1 ${form.currency}`}
              hint="Enter the exchange rate for this transaction."
            >
              <input
                type="number"
                min="0.00000001"
                step="0.00000001"
                value={form.rate}
                onChange={(e) => set("rate", e.target.value)}
                required
              />
            </Field>
            <div className="conversion">
              <span>PKR equivalent</span>
              <strong>{money(Number(form.amount) * Number(form.rate))}</strong>
            </div>
          </>
        )}
        {cross && (
          <>
            <Field label={`Amount received · ${targetAccount.currency}`}>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={form.targetAmount || ""}
                onChange={(e) => set("targetAmount", e.target.value)}
                required
              />
            </Field>
            {targetAccount.currency !== "PKR" && (
              <Field label={`PKR per 1 ${targetAccount.currency}`}>
                <input
                  type="number"
                  min="0.00000001"
                  step="0.00000001"
                  value={form.targetRate || ""}
                  onChange={(e) => set("targetRate", e.target.value)}
                  required
                />
              </Field>
            )}
          </>
        )}
        {k === "opening" && (
          <Field label="Opening balance side">
            <select
              value={form.openingSide}
              onChange={(e) => set("openingSide", e.target.value)}
            >
              <option value="debit">Debit (usually assets / expenses)</option>
              <option value="credit">
                Credit (usually liabilities / equity)
              </option>
            </select>
          </Field>
        )}
        {category && (
          <Field label="Expense category">
            <Select
              value={form.categoryId}
              onChange={(v) => {
                set("categoryId", v ? Number(v) : null);
                set("headId", null);
              }}
              options={data.categories
                .filter(
                  (c) =>
                    c.active &&
                    (k === "bill" ||
                      data.accounts.find((a) => a.id === c.account_id)?.type ===
                        "expense"),
                )
                .map((c) => ({
                  ...c,
                  name:
                    (c.parent_id
                      ? data.categories.find((p) => p.id === c.parent_id)
                          ?.name + " / "
                      : "") + c.name,
                }))}
              placeholder="Select category (or account below)"
            />
          </Field>
        )}
        {head && !form.categoryId && (
          <Field
            label={
              k === "receipt"
                ? "Source of money / income head"
                : k === "invoice"
                  ? "Revenue account"
                  : "Expense account"
            }
          >
            <Select
              required
              value={form.headId}
              onChange={(v) => set("headId", Number(v))}
              options={heads}
            />
          </Field>
        )}
        <Field label={contactKind ? title(contactKind) : "Contact (optional)"}>
          <Select
            value={form.contactId}
            required={!!contactKind && k !== "asset_purchase"}
            options={data.contacts.filter(
              (c) => c.active && (!contactKind || c.kind === contactKind),
            )}
            onChange={(v) => set("contactId", v ? Number(v) : null)}
            placeholder={contactKind ? `Select ${contactKind}` : "No contact"}
          />
        </Field>
        <Field label="Project (optional)">
          <Select
            value={form.projectId}
            onChange={(v) => set("projectId", v ? Number(v) : null)}
            options={data.projects.filter((p) => p.active)}
            placeholder="General company activity"
          />
        </Field>
        {["invoice", "bill"].includes(k) && (
          <Field label="Due date">
            <input
              type="date"
              value={form.dueDate || ""}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
        )}
        {asset && (
          <>
            <div className="form-section wide">
              <Package size={18} />
              <strong>Asset details</strong>
            </div>
            <Field label="Asset name">
              <input
                value={form.assetName || ""}
                onChange={(e) => set("assetName", e.target.value)}
                placeholder="e.g. Animation workstation"
                required
              />
            </Field>
            <Field label="Useful life (months)">
              <input
                type="number"
                min="1"
                max="600"
                value={form.usefulLife}
                onChange={(e) => set("usefulLife", Number(e.target.value))}
                required
              />
            </Field>
            <Field label="Salvage value (PKR)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={form.salvage}
                onChange={(e) => set("salvage", e.target.value)}
                required
              />
            </Field>
          </>
        )}
        <Field label="Description / notes" wide>
          <textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            required
            rows={3}
            placeholder="What is this transaction for?"
          />
        </Field>
        <div className="info wide">
          <FileText size={18} />
          <span>
            This saves a draft. Attach receipts and submit for approval from the
            transaction details.
          </span>
        </div>
      </FormShell>
    </Modal>
  );
}

function DocumentDetail({
  doc,
  data,
  base,
  user,
  can,
  onEdit,
  onClose,
  onAction,
  onSettle,
}: {
  doc: Row;
  data: Data;
  base: string;
  user: User;
  can: (s: string) => boolean;
  onEdit: () => void;
  onClose: () => void;
  onAction: (a: string, b?: Row) => Promise<void>;
  onSettle: (k: string) => void;
}) {
  const [attachments, setAttachments] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [reversing, setReversing] = useState(false),
    [reverseDate, setReverseDate] = useState(today());
  const load = () =>
    api(`${base}/documents/${doc.id}/attachments`)
      .then(setAttachments)
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (!doc.inbound) void load();
  }, [doc.id]);
  const action = async (a: string, b?: Row) => {
    setBusy(true);
    setError("");
    try {
      await onAction(a, b);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canActOnDocument = user.dataScope !== "own" || doc.can_manage === true;
  const approvalBlockReason = !canActOnDocument
    ? "This transaction was recorded for you. Your finance team manages its approval and posting."
    : !can("transactions.approve")
      ? "Your account does not have transaction approval permission. Anyone with this permission can approve, including the creator."
      : null;
  const canManageSubmission =
    canActOnDocument &&
    (user.role !== "employee" || doc.created_by === user.id);
  const outstanding = Number(doc.amount) - Number(doc.allocated || 0),
    settleKind =
      doc.kind === "invoice"
        ? "client_payment"
        : doc.kind === "bill" ||
            (doc.kind === "asset_purchase" && !doc.source_id)
          ? "vendor_payment"
          : doc.kind === "advance"
            ? "advance_expense"
            : null;
  return (
    <Modal
      title={`Transaction #${String(doc.id).padStart(5, "0")}`}
      description={kindLabels[doc.kind]}
      onClose={onClose}
      wide
    >
      <div className="document-banner">
        <div>
          <span>
            {doc.inbound
              ? "Incoming inter-company transfer"
              : "Transaction amount"}
          </span>
          <strong>{money(doc.amount, doc.currency)}</strong>
          {doc.currency !== "PKR" && (
            <small>
              {money(doc.base_amount)} · Rate {num(doc.rate)}
            </small>
          )}
        </div>
        <Badge status={doc.status} />
      </div>
      <h3 className="document-description">{doc.description}</h3>
      <dl className="detail-grid">
        {[
          ["Date", dateLabel(doc.date)],
          ["Reference", doc.reference || "—"],
          [
            "Contact",
            doc.contact_name ||
              data.contacts.find((c) => c.id === doc.contact_id)?.name ||
              "—",
          ],
          [
            "Project",
            doc.project_name ||
              data.projects.find((p) => p.id === doc.project_id)?.name ||
              "General company",
          ],
          [
            "Paid from",
            data.accounts.find((a) => a.id === doc.source_id)?.name || "—",
          ],
          [
            "Receiving account",
            data.accounts.find((a) => a.id === doc.target_id)?.name || "—",
          ],
          ["Created by", doc.creator || "—"],
          ["Due date", dateLabel(doc.due_date)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {settleKind && doc.status === "posted" && (
        <div className="info">
          <Wallet size={18} />
          <span>
            Outstanding: <strong>{money(outstanding, doc.currency)}</strong>
          </span>
        </div>
      )}
      {!doc.inbound && (
        <div className="attachment-section">
          <div className="section-heading">
            <h3>
              <Paperclip size={17} />
              Receipts & documents
            </h3>
            {canManageSubmission && can("transactions.create") && (
              <label className="button secondary compact upload-label">
                <Plus size={15} />
                Attach files
                <input
                  type="file"
                  multiple
                  accept="application/pdf,image/png,image/jpeg,image/webp"
                  disabled={busy}
                  onChange={async (e) => {
                    const files = e.target.files;
                    if (!files?.length) return;
                    const body = new FormData();
                    Array.from(files).forEach((f) => body.append("files", f));
                    setBusy(true);
                    setError("");
                    try {
                      await api(
                        `${base}/documents/${doc.id}/attachments`,
                        "POST",
                        body,
                      );
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                      e.target.value = "";
                    }
                  }}
                />
              </label>
            )}
          </div>
          {attachments.length ? (
            <div className="attachment-list">
              {attachments.map((a) => (
                <a
                  key={a.id}
                  href={`${base}/documents/${doc.id}/attachments/${a.id}`}
                >
                  <FileText size={17} />
                  <span>
                    {a.filename}
                    <small>{num(a.size / 1024)} KB</small>
                  </span>
                  <Download size={16} />
                </a>
              ))}
            </div>
          ) : (
            <p className="subtle">
              No documents attached. PDF, JPG, PNG, or WebP, up to 20 MB each.
            </p>
          )}
        </div>
      )}
      {reversing && (
        <div className="reversal-panel">
          <h3>Reverse this transaction</h3>
          <p>
            A correcting journal will preserve the original accounting history.
          </p>
          <Field label="Reversal date">
            <input
              type="date"
              required
              value={reverseDate}
              onChange={(e) => setReverseDate(e.target.value)}
            />
          </Field>
          <button
            className="button danger"
            disabled={busy || !reverseDate}
            onClick={() => action("reverse", { date: reverseDate })}
          >
            Confirm reversal
          </button>
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!doc.inbound && doc.status === "submitted" && approvalBlockReason && (
        <div className="info" id="approval-restriction" role="status">
          <ShieldCheck size={18} />
          <span>{approvalBlockReason}</span>
        </div>
      )}
      <div className="modal-footer wrap">
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
        {!doc.inbound && (
          <>
            {canManageSubmission &&
              can("transactions.create") &&
              ["draft", "rejected"].includes(doc.status) && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={onEdit}
                >
                  Edit draft
                </button>
              )}
            {canManageSubmission &&
              can("transactions.create") &&
              ["draft", "submitted", "approved", "rejected"].includes(
                doc.status,
              ) && (
                <button
                  className="text-button negative"
                  disabled={busy}
                  onClick={() => action("cancel")}
                >
                  Cancel transaction
                </button>
              )}
            {canManageSubmission &&
              can("transactions.submit") &&
              ["draft", "rejected"].includes(doc.status) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => action("submit")}
                >
                  Submit for approval
                </button>
              )}
            {canActOnDocument && doc.status === "submitted" && (
              <>
                <button
                  className="button secondary"
                  disabled={busy || !!approvalBlockReason}
                  aria-describedby={
                    approvalBlockReason ? "approval-restriction" : undefined
                  }
                  onClick={() => action("reject")}
                >
                  Reject
                </button>
                <button
                  className="button"
                  disabled={busy || !!approvalBlockReason}
                  aria-describedby={
                    approvalBlockReason ? "approval-restriction" : undefined
                  }
                  onClick={() => action("approve")}
                >
                  Approve
                </button>
              </>
            )}
            {canActOnDocument &&
              can("transactions.post") &&
              (doc.status === "approved" ||
                (doc.status === "draft" &&
                  (!data.company.approvals ||
                    ["opening", "adjustment"].includes(doc.kind)))) && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => action("post")}
                >
                  Post transaction
                </button>
              )}
            {canActOnDocument &&
              can("transactions.reverse") &&
              doc.status === "posted" &&
              !reversing && (
                <button
                  className="button secondary"
                  onClick={() => setReversing(true)}
                >
                  Reverse
                </button>
              )}
            {can("transactions.create") &&
              doc.status === "posted" &&
              settleKind &&
              outstanding > 0 && (
                <button className="button" onClick={() => onSettle(settleKind)}>
                  {kindLabels[settleKind]}
                </button>
              )}
            {can("transactions.create") &&
              doc.status === "posted" &&
              doc.kind === "advance" &&
              outstanding > 0 && (
                <button
                  className="button secondary"
                  onClick={() => onSettle("advance_return")}
                >
                  Return remaining funds
                </button>
              )}
          </>
        )}
      </div>
    </Modal>
  );
}

function Assets({
  base,
  refresh,
  can,
  notify,
  reload,
  onNew,
}: {
  base: string;
  refresh: number;
  can: (p: string) => boolean;
  notify: (s: string) => void;
  reload: () => void;
  onNew: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [asset, setAsset] = useState<Row | null>(null),
    [date, setDate] = useState(today());
  useEffect(() => {
    api(base + "/assets")
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [base, refresh]);
  return (
    <>
      <div className="mini-stats">
        <div className="card">
          <span>Acquisition cost</span>
          <strong>
            {money(
              rows
                .filter((a) => a.active)
                .reduce((s, a) => s + Number(a.cost), 0),
            )}
          </strong>
        </div>
        <div className="card">
          <span>Accumulated depreciation</span>
          <strong>
            {money(
              rows
                .filter((a) => a.active)
                .reduce((s, a) => s + Number(a.depreciated), 0),
            )}
          </strong>
        </div>
        <div className="card">
          <span>Net book value</span>
          <strong>
            {money(
              rows
                .filter((a) => a.active)
                .reduce(
                  (s, a) => s + Number(a.cost) - Number(a.depreciated),
                  0,
                ),
            )}
          </strong>
        </div>
      </div>
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Asset register</h2>
            <p>
              Monthly straight-line depreciation, with a retained audit trail.
            </p>
          </div>
          {can("transactions.create") && (
            <button className="button compact" onClick={onNew}>
              <Plus size={16} />
              Purchase asset
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Acquired</th>
                  <th>Useful life</th>
                  <th className="align-right">Cost</th>
                  <th className="align-right">Book value</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>
                      <small>{a.active ? "Active" : "Reversed purchase"}</small>
                    </td>
                    <td>{dateLabel(a.acquired)}</td>
                    <td>{a.useful_life} months</td>
                    <td className="align-right">{money(a.cost)}</td>
                    <td className="align-right amount">
                      {money(Number(a.cost) - Number(a.depreciated))}
                    </td>
                    <td>
                      {can("accounting.manage") &&
                        a.active &&
                        Number(a.cost) - Number(a.depreciated) >
                          Number(a.salvage) && (
                          <button
                            className="text-button"
                            onClick={() => setAsset(a)}
                          >
                            Depreciate
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="Your asset register is ready"
            text="Post an asset purchase to track its cost and depreciation here."
          />
        )}
      </section>
      {asset && (
        <Modal
          title={`Depreciate ${asset.name}`}
          description="Post one monthly depreciation installment."
          onClose={() => setAsset(null)}
        >
          <FormShell
            onClose={() => setAsset(null)}
            saveLabel="Post depreciation"
            onSave={async () => {
              await api(`${base}/assets/${asset.id}/depreciate`, "POST", {
                date,
              });
              setAsset(null);
              notify("Monthly depreciation posted");
              reload();
            }}
          >
            <Field label="Posting date">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </Field>
            <div className="info">
              Monthly depreciation:{" "}
              {money(
                (Number(asset.cost) - Number(asset.salvage)) /
                  asset.useful_life,
              )}
              . The final installment is capped at the remaining depreciable
              value.
            </div>
          </FormShell>
        </Modal>
      )}
    </>
  );
}
function Reports({
  report,
  documents,
  data,
  to,
}: {
  report: Row | null;
  documents: Row[];
  data: Data;
  to: string;
}) {
  const [type, setType] = useState("profit"),
    [account, setAccount] = useState(""),
    [contact, setContact] = useState("");
  const types = [
    ["profit", "Profit & loss"],
    ["balance", "Balance sheet"],
    ["cashflow", "Cash flow"],
    ["trial", "Trial balance"],
    ["ledger", "General ledger"],
    ["journal", "Journal"],
    ["category", "Expenses by category"],
    ["project", "Project performance"],
    ["employee", "Employee advances"],
    ["employee_expenses", "Expense by employee"],
    ["employee_cash", "Cash by employee"],
    ["cash", "Cash position"],
    ["bank", "Bank statement"],
    ["receivables", "Receivables aging"],
    ["payables", "Payables aging"],
    ["contact", "Client / vendor statement"],
    ["intercompany", "Inter-company statement"],
  ];
  if (!report)
    return (
      <div className="card">
        <Empty
          title="Reports are loading"
          text="Your posted accounting records will appear here."
        />
      </div>
    );
  let rows: Row[] = [],
    columns: [string, string, string?][] = [
      ["name", "Account"],
      ["debit", "Debit", "money"],
      ["credit", "Credit", "money"],
      ["balance", "Balance", "money"],
    ];
  if (type === "profit") {
    rows = (report.activity || [])
      .filter((r: Row) => ["revenue", "expense"].includes(r.type))
      .map((r: Row) => ({
        ...r,
        amount: r.type === "revenue" ? -Number(r.balance) : Number(r.balance),
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
    ].map((r) => ({
      ...r,
      balance: r.type === "asset" ? Number(r.balance) : -Number(r.balance),
    }));
    rows.push({
      id: "earnings",
      name: "Current retained earnings",
      type: "equity",
      balance: report.balanceSheet?.earnings || 0,
    });
    columns = [
      ["name", "Account"],
      ["type", "Type"],
      ["balance", "Balance", "money"],
    ];
  } else if (type === "trial") rows = report.trial || [];
  else if (type === "cashflow") rows = report.cashFlow || [];
  else if (type === "category") rows = report.byCategory || [];
  else if (type === "project") {
    rows = report.byProject || [];
    columns = [
      ["name", "Project"],
      ["revenue", "Revenue", "money"],
      ["expenses", "Expenses", "money"],
      ["profit", "Profit / loss", "money"],
    ];
  } else if (type === "employee") rows = report.byEmployee || [];
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
  } else if (
    ["ledger", "journal", "bank", "contact", "intercompany"].includes(type)
  ) {
    rows = (report.ledger || []).filter(
      (r: Row) =>
        (!account || r.account_id === Number(account)) &&
        (!contact || r.contact_id === Number(contact)) &&
        (type !== "bank" || r.purpose === "bank") &&
        (type !== "contact" ||
          ["receivable", "payable", "advance"].includes(r.purpose)) &&
        (type !== "intercompany" || ["due_from", "due_to"].includes(r.purpose)),
    );
    columns = [
      ["date", "Date", "date"],
      ["document_id", "Document"],
      ["account_name", "Account"],
      ["description", "Description"],
      ["contact_name", "Contact"],
      ["debit", "Debit", "money"],
      ["credit", "Credit", "money"],
    ];
  } else if (type === "receivables" || type === "payables") {
    const supplied =
      type === "receivables" ? report.agingReceivables : report.agingPayables;
    rows =
      supplied ||
      documents
        .filter(
          (d) =>
            d.status === "posted" &&
            Number(d.amount) > Number(d.allocated) &&
            (type === "receivables"
              ? d.kind === "invoice"
              : d.kind === "bill" ||
                (d.kind === "asset_purchase" && !d.source_id)),
        )
        .map((d) => {
          const days = d.due_date
            ? Math.max(
                0,
                Math.floor(
                  (Date.parse(to) - Date.parse(d.due_date)) / 86400000,
                ),
              )
            : 0;
          return {
            ...d,
            outstanding: Number(d.amount) - Number(d.allocated),
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
      ["outstanding", "Outstanding", "number"],
      ["bucket", "Aging"],
    ];
  }
  return (
    <section className="card">
      <div className="report-toolbar">
        <select
          aria-label="Report"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setAccount("");
            setContact("");
          }}
        >
          {types.map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {["ledger", "bank", "journal"].includes(type) && (
          <Select
            value={account}
            onChange={setAccount}
            options={data.accounts.filter(
              (a) => type !== "bank" || a.purpose === "bank",
            )}
            placeholder="All accounts"
          />
        )}
        {type === "contact" && (
          <Select
            value={contact}
            onChange={setContact}
            options={data.contacts}
            placeholder="All contacts"
          />
        )}
        <button
          className="button secondary compact"
          disabled={!rows.length}
          onClick={() =>
            exportCSV(types.find(([k]) => k === type)?.[1] || type, rows)
          }
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
        <h2>{types.find(([k]) => k === type)?.[1]}</h2>
        <p>
          As of {dateLabel(to)} · Base currency PKR
          {["receivables", "payables"].includes(type)
            ? " · Outstanding shown in document currency"
            : ""}
        </p>
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map(([k, label, format]) => (
                  <th
                    key={k}
                    className={
                      format === "money" || format === "number"
                        ? "align-right"
                        : ""
                    }
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={String(r.id || "") + i}>
                  {columns.map(([k, , format]) => (
                    <td
                      key={k}
                      className={
                        format === "money" || format === "number"
                          ? "align-right amount"
                          : ""
                      }
                    >
                      {format === "money"
                        ? money(r[k])
                        : format === "number"
                          ? num(r[k])
                          : format === "date"
                            ? dateLabel(r[k])
                            : (r[k] ?? "—")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="No activity for this report"
          text="Try another date range or post a transaction to see it here."
        />
      )}
      {type === "profit" && (
        <div className="report-total">
          <strong>Net profit / loss</strong>
          <strong>{money(report.summary?.profit)}</strong>
        </div>
      )}
      {type === "trial" && (
        <div className="report-total">
          <strong>Total debits / credits</strong>
          <span>
            {money(rows.reduce((s, r) => s + Number(r.debit), 0))} /{" "}
            {money(rows.reduce((s, r) => s + Number(r.credit), 0))}
          </span>
        </div>
      )}
    </section>
  );
}
function Reconciliation({
  base,
  data,
  notify,
  reload,
  refresh,
}: {
  base: string;
  data: Data;
  notify: (s: string) => void;
  reload: () => void;
  refresh: number;
}) {
  const [rows, setRows] = useState<Row[]>([]),
    [account, setAccount] = useState(""),
    [date, setDate] = useState(today()),
    [balance, setBalance] = useState(""),
    [ids, setIds] = useState<number[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(base + "/reconciliation")
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [base, refresh]);
  const filtered = rows.filter(
    (r) =>
      r.account_id === Number(account) &&
      !r.reconciliation_id &&
      r.date <= date,
  );
  const cleared = rows
      .filter((r) => r.account_id === Number(account) && r.reconciliation_id)
      .reduce((s, r) => s + Number(r.foreign_amount), 0),
    selected = rows
      .filter((r) => ids.includes(r.id))
      .reduce((s, r) => s + Number(r.foreign_amount), 0);
  const currency =
    data.accounts.find((a) => a.id === Number(account))?.currency || "PKR";
  return (
    <section className="card">
      <div className="card-heading">
        <div>
          <h2>Match your bank statement</h2>
          <p>
            Select cleared transactions until the balance matches your
            statement.
          </p>
        </div>
      </div>
      <div className="reconciliation-form">
        <Field label="Bank account">
          <Select
            value={account}
            onChange={(v) => {
              setAccount(v);
              setIds([]);
            }}
            options={data.accounts.filter((a) => a.purpose === "bank")}
            required
          />
        </Field>
        <Field label="Statement date">
          <input
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setIds([]);
            }}
          />
        </Field>
        <Field label={`Statement closing balance · ${currency}`}>
          <input
            type="number"
            step="0.01"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="0.00"
          />
        </Field>
      </div>
      <div className="reconciliation-summary">
        <span>
          Previously cleared <strong>{money(cleared, currency)}</strong>
        </span>
        <span>
          Selected movement <strong>{money(selected, currency)}</strong>
        </span>
        <span>
          Difference{" "}
          <strong
            className={
              Math.abs(Number(balance) - cleared - selected) < 0.005
                ? "positive"
                : "negative"
            }
          >
            {money(Number(balance) - cleared - selected, currency)}
          </strong>
        </span>
      </div>
      {error && <div className="error">{error}</div>}
      {filtered.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th />
                <th>Date</th>
                <th>Description</th>
                <th className="align-right">Movement</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      aria-label={`Select ${r.description}`}
                      type="checkbox"
                      checked={ids.includes(r.id)}
                      onChange={(e) =>
                        setIds((current) =>
                          e.target.checked
                            ? [...current, r.id]
                            : current.filter((i) => i !== r.id),
                        )
                      }
                    />
                  </td>
                  <td>{dateLabel(r.date)}</td>
                  <td>{r.description}</td>
                  <td className="align-right amount">
                    {money(r.foreign_amount, currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={
            account ? "No uncleared transactions" : "Select a bank account"
          }
          text="Posted bank entries that have not been reconciled will appear here."
        />
      )}
      <div className="modal-footer">
        <button
          className="button"
          disabled={busy || !ids.length || !balance}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api(base + "/reconciliation", "POST", {
                accountId: Number(account),
                date,
                balance,
                lineIds: ids,
              });
              setIds([]);
              notify("Bank statement reconciled");
              reload();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Complete reconciliation
        </button>
      </div>
    </section>
  );
}
function Audit({ base, refresh }: { base: string; refresh: number }) {
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [detail, setDetail] = useState<Row | null>(null);
  useEffect(() => {
    api(base + "/audit")
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [base, refresh]);
  return (
    <>
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Activity history</h2>
            <p>Latest 500 recorded changes for this company.</p>
          </div>
          <button
            className="button secondary compact"
            onClick={() => exportCSV("audit-trail", rows)}
            disabled={!rows.length}
          >
            <Download size={16} />
            Export
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Record</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {new Date(r.created_at).toLocaleString("en-GB", {
                        timeZone: "Asia/Karachi",
                      })}
                    </td>
                    <td>
                      <strong>{r.full_name}</strong>
                    </td>
                    <td>{title(r.action)}</td>
                    <td>
                      {title(r.entity)} #{r.entity_id}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setDetail(r)}
                      >
                        View changes
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No audit activity"
            text="Changes are recorded automatically as your team works."
          />
        )}
      </section>
      {detail && (
        <Modal
          title={`${title(detail.action)} ${detail.entity} #${detail.entity_id}`}
          description={`${detail.full_name} · ${new Date(detail.created_at).toLocaleString()}`}
          onClose={() => setDetail(null)}
          wide
        >
          <div className="audit-diff">
            <div>
              <h3>Previous values</h3>
              <pre>
                {JSON.stringify(detail.before_value, null, 2) ||
                  "No previous record"}
              </pre>
            </div>
            <div>
              <h3>New values</h3>
              <pre>
                {JSON.stringify(detail.after_value, null, 2) || "No new values"}
              </pre>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
function SettingsPage({
  data,
  onNewCompany,
  onSave,
}: {
  data: Data;
  onNewCompany: () => void;
  onSave: (d: Row) => Promise<void>;
}) {
  const [form, setForm] = useState<Row>(data.company),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState({ currentPassword: "", password: "" }),
    [passMessage, setPassMessage] = useState("");
  useEffect(() => {
    setForm(data.company);
  }, [data.company]);
  return (
    <div className="settings-grid">
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Company configuration</h2>
            <p>Settings apply to this company only.</p>
          </div>
        </div>
        <form
          className="settings-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            setSaved(false);
            try {
              await onSave({
                name: form.name,
                approvals: form.approvals,
                locked_through: form.locked_through || null,
              });
              setSaved(true);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Company name">
            <input
              value={form.name || ""}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              required
            />
          </Field>
          <Field label="Base currency">
            <input value="PKR — Pakistani rupee" disabled />
          </Field>
          <label className="toggle-row">
            <span>
              <strong>Require approval before posting</strong>
              <small>
                Anyone with approval permission can approve, including the
                creator.
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={!!form.approvals}
              onChange={(e) =>
                setForm((f) => ({ ...f, approvals: e.target.checked }))
              }
            />
          </label>
          <Field
            label="Lock accounting through"
            hint="New postings and reversals dated on or before this date are blocked."
          >
            <input
              type="date"
              value={form.locked_through || ""}
              onChange={(e) =>
                setForm((f) => ({ ...f, locked_through: e.target.value }))
              }
            />
          </Field>
          {error && <div className="error">{error}</div>}
          {saved && <p className="positive">Settings saved.</p>}
          <button className="button" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      </section>
      <div className="form-stack">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Another business entity?</h2>
              <p>Create separate books for another company.</p>
            </div>
            <Building2 size={22} />
          </div>
          <div className="card-body">
            <p className="subtle">
              Each company maintains its own accounts, balances, approvals, and
              accounting periods.
            </p>
            <button className="button secondary" onClick={onNewCompany}>
              <Plus size={16} />
              Create company
            </button>
          </div>
        </section>
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Change your password</h2>
              <p>Use at least 12 characters.</p>
            </div>
          </div>
          <form
            className="settings-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setPassMessage("");
              try {
                await api("/api/auth/change-password", "POST", password);
                setPassword({ currentPassword: "", password: "" });
                setPassMessage("Password updated. Please sign in again.");
                setTimeout(() => window.location.reload(), 1000);
              } catch (e) {
                setPassMessage((e as Error).message);
              }
            }}
          >
            <Field label="Current password">
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password.currentPassword}
                onChange={(e) =>
                  setPassword((p) => ({
                    ...p,
                    currentPassword: e.target.value,
                  }))
                }
              />
            </Field>
            <Field label="New password">
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password.password}
                onChange={(e) =>
                  setPassword((p) => ({ ...p, password: e.target.value }))
                }
              />
            </Field>
            {passMessage && <p role="status">{passMessage}</p>}
            <button className="button secondary">Update password</button>
          </form>
        </section>
      </div>
    </div>
  );
}

function Admin({
  companies,
  currentUser,
  notify,
  refresh,
  reload,
}: {
  companies: Row[];
  currentUser: User;
  notify: (s: string) => void;
  refresh: number;
  reload: () => void;
}) {
  const [admin, setAdmin] = useState<Row>({
      users: [],
      roles: [],
      memberships: [],
      employeeLinks: [],
      employees: [],
      permissions: [],
    }),
    [error, setError] = useState(""),
    [tab, setTab] = useState("users"),
    [editing, setEditing] = useState<Row | null>(null);
  useEffect(() => {
    api("/api/admin")
      .then(setAdmin)
      .catch((e) => setError(e.message));
  }, [refresh]);
  return (
    <>
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Access management</h2>
            <p>Enable or disable users and individual permissions.</p>
          </div>
          <button
            className="button compact"
            onClick={() => setEditing({ type: tab })}
          >
            <Plus size={16} />
            Add {tab === "users" ? "user" : "role"}
          </button>
        </div>
        <div className="tabs">
          <button
            className={tab === "users" ? "active" : ""}
            onClick={() => setTab("users")}
          >
            Users<span>{admin.users.length}</span>
          </button>
          <button
            className={tab === "roles" ? "active" : ""}
            onClick={() => setTab("roles")}
          >
            Roles & permissions<span>{admin.roles.length}</span>
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {(tab === "users"
                  ? [
                      "Name",
                      "Username",
                      "Email",
                      "Role",
                      "Data visibility",
                      "Status",
                      "",
                    ]
                  : ["Role", "Enabled permissions", ""]
                ).map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(tab === "users" ? admin.users : admin.roles).map((r: Row) => (
                <tr key={r.id}>
                  {tab === "users" ? (
                    <>
                      <td>
                        <strong>{r.full_name}</strong>
                      </td>
                      <td>{r.username}</td>
                      <td>{r.email || "—"}</td>
                      <td>
                        {title(
                          admin.roles.find((role: Row) => role.id === r.role_id)
                            ?.name || "",
                        )}
                      </td>
                      <td>
                        {admin.roles.find((role: Row) => role.id === r.role_id)
                          ?.name === "super_admin"
                          ? "All company data"
                          : r.data_scope === "own"
                            ? "Own data only"
                            : r.data_scope === "company"
                              ? "All company data"
                              : "Inherit role"}
                      </td>
                      <td>
                        <Badge status={r.active ? "active" : "disabled"} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <strong>{title(r.name)}</strong>
                      </td>
                      <td>
                        {r.permissions.length} of {admin.permissions.length}
                      </td>
                    </>
                  )}
                  <td>
                    {!(tab === "users" && r.id === currentUser.id) &&
                    !(
                      tab === "users" &&
                      admin.roles.find((role: Row) => role.id === r.role_id)
                        ?.name === "super_admin"
                    ) &&
                    !(tab === "roles" && r.name === "super_admin") ? (
                      <button
                        className="text-button"
                        onClick={() => setEditing({ type: tab, ...r })}
                      >
                        Manage
                      </button>
                    ) : (
                      <span className="subtle">
                        {tab === "users" && r.id === currentUser.id
                          ? "You"
                          : "Protected"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editing && (
        <AccessModal
          item={editing}
          admin={admin}
          companies={companies}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            await api(`/api/admin/${editing.type}`, "POST", d);
            setEditing(null);
            notify("Access settings saved");
            reload();
          }}
        />
      )}
    </>
  );
}
function AccessModal({
  item,
  admin,
  companies,
  onClose,
  onSave,
}: {
  item: Row;
  admin: Row;
  companies: Row[];
  onClose: () => void;
  onSave: (d: Row) => Promise<void>;
}) {
  const isUser = item.type === "users";
  const [form, setForm] = useState<Row>({
    name: "",
    username: "",
    email: "",
    full_name: "",
    password: "",
    role_id: admin.roles.find((r: Row) => r.name === "viewer")?.id,
    active: true,
    overrides: {},
    permissions: [],
    data_scope: null,
    ...item,
    companies: admin.memberships
      .filter((m: Row) => m.user_id === item.id)
      .map((m: Row) => m.company_id),
    employee_links: (admin.employeeLinks || [])
      .filter((link: Row) => link.user_id === item.id)
      .map(({ company_id, contact_id }: Row) => ({ company_id, contact_id })),
  });
  const set = (key: string, v: any) => setForm((f) => ({ ...f, [key]: v }));
  return (
    <Modal
      title={`${item.id ? "Manage" : "Add"} ${isUser ? "user" : "role"}`}
      onClose={onClose}
      wide
    >
      <FormShell
        onClose={onClose}
        saveLabel="Save access"
        wide
        onSave={() => {
          const payload = { ...form };
          delete payload.type;
          if (!payload.password) delete payload.password;
          if (isUser) {
            payload.email = form.email?.trim() || null;
            payload.employee_links = form.employee_links.filter((link: Row) =>
              form.companies.includes(link.company_id),
            );
            if (
              admin.roles.find((role: Row) => role.id === form.role_id)
                ?.name === "super_admin"
            )
              payload.data_scope = null;
          }
          return onSave(payload);
        }}
      >
        {isUser ? (
          <>
            <Field label="Full name">
              <input
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
                required
              />
            </Field>
            <Field label="Username">
              <input
                autoComplete="off"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                required
              />
            </Field>
            <Field
              label={item.id ? "New password (optional)" : "Password"}
              hint="At least 12 characters"
            >
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required={!item.id}
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
              />
            </Field>
            <Field label="Email (optional)">
              <input
                type="email"
                autoComplete="off"
                value={form.email || ""}
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field label="Role">
              <Select
                required
                value={form.role_id}
                onChange={(v) => set("role_id", Number(v))}
                options={admin.roles
                  .filter((r: Row) => r.name !== "super_admin")
                  .map((r: Row) => ({
                    ...r,
                    name: title(r.name),
                  }))}
              />
            </Field>
            <Field label="Data visibility" wide>
              <select
                value={form.data_scope || "inherit"}
                disabled={
                  admin.roles.find((role: Row) => role.id === form.role_id)
                    ?.name === "super_admin"
                }
                onChange={(e) =>
                  set(
                    "data_scope",
                    e.target.value === "inherit" ? null : e.target.value,
                  )
                }
              >
                <option value="inherit">Inherit role</option>
                <option value="own">Own data only</option>
                <option value="company">All assigned company data</option>
              </select>
              <small>
                Own data only shows this user's submissions, assigned cash, and
                advances. Company income, private payroll, and other users'
                records stay hidden, even when approval permission is enabled.
                Inherit role gives employees own-data access and other roles
                company data. Super administrators retain full access.
              </small>
            </Field>
            <label className="checkbox-label wide">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => set("active", e.target.checked)}
              />
              Account enabled
            </label>
            <div className="wide">
              <h3>Company access</h3>
              <div className="permission-checks">
                {companies.map((c) => (
                  <label className="checkbox-label" key={c.id}>
                    <input
                      type="checkbox"
                      checked={form.companies.includes(c.id)}
                      onChange={(e) =>
                        set(
                          "companies",
                          e.target.checked
                            ? [...form.companies, c.id]
                            : form.companies.filter(
                                (id: number) => id !== c.id,
                              ),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
              <small className="subtle">
                Super administrators have access to every company.
              </small>
            </div>
            <div className="wide employee-links">
              <h3>Employee / cash custodian links</h3>
              <p className="subtle">
                Link this login to an employee in each assigned company so the
                user can see cash held in their name and advances issued to
                them.
              </p>
              {companies
                .filter((company) => form.companies.includes(company.id))
                .map((company) => (
                  <Field key={company.id} label={`${company.name} employee`}>
                    <Select
                      value={
                        form.employee_links.find(
                          (link: Row) => link.company_id === company.id,
                        )?.contact_id
                      }
                      placeholder="No employee linked"
                      options={(admin.employees || []).filter(
                        (employee: Row) =>
                          employee.company_id === company.id &&
                          employee.active !== false,
                      )}
                      onChange={(value) => {
                        const links = form.employee_links.filter(
                          (link: Row) => link.company_id !== company.id,
                        );
                        if (value)
                          links.push({
                            company_id: company.id,
                            contact_id: Number(value),
                          });
                        set("employee_links", links);
                      }}
                    />
                  </Field>
                ))}
              {!form.companies.length && (
                <small className="subtle">
                  Select company access above to choose employee records.
                </small>
              )}
            </div>
          </>
        ) : (
          <Field label="Role name" wide>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              disabled={[
                "super_admin",
                "finance",
                "manager",
                "employee",
                "viewer",
              ].includes(item.name)}
              required
            />
          </Field>
        )}
        <div className="wide permissions-editor">
          <h3>
            {isUser ? "Individual permission overrides" : "Module permissions"}
          </h3>
          <p className="subtle">
            {isUser
              ? "Inherit the role’s permission, or explicitly enable or disable it for this user."
              : "Select the actions available to users assigned this role."}
          </p>
          {admin.permissions.map((p: string) => (
            <div className="permission-row" key={p}>
              <span>
                {title(p.split(".")[0])}
                <small>{title(p.split(".")[1])}</small>
              </span>
              {isUser ? (
                <select
                  aria-label={p}
                  value={
                    form.overrides[p] === undefined
                      ? "inherit"
                      : form.overrides[p]
                        ? "allow"
                        : "deny"
                  }
                  onChange={(e) => {
                    const next = { ...form.overrides };
                    if (e.target.value === "inherit") delete next[p];
                    else next[p] = e.target.value === "allow";
                    set("overrides", next);
                  }}
                >
                  <option value="inherit">Inherit role</option>
                  <option value="allow">Enabled</option>
                  <option value="deny">Disabled</option>
                </select>
              ) : (
                <input
                  aria-label={p}
                  type="checkbox"
                  role="switch"
                  checked={form.permissions.includes(p)}
                  onChange={(e) =>
                    set(
                      "permissions",
                      e.target.checked
                        ? [...form.permissions, p]
                        : form.permissions.filter((s: string) => s !== p),
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>
      </FormShell>
    </Modal>
  );
}
