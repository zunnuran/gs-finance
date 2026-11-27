import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search } from "lucide-react";
import { sortRows } from "./tableSort";

type AccountOption = {
  id: number;
  name: string;
  code: string;
  currency: string;
  active: boolean;
};

export function AccountFilter({
  accounts,
  value,
  onChange,
  disabled = false,
}: {
  accounts: AccountOption[];
  value: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}) {
  const panelId = `account-filter-${useId()}`;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({});
  const sorted = useMemo(
    () => sortRows(accounts, (account) => account.name, "asc"),
    [accounts],
  );
  const filtered = sorted.filter((account) =>
    `${account.name} ${account.code} ${account.currency}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const selected = new Set(value);
  const close = () => {
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (!button.current) return;
      const rect = button.current.getBoundingClientRect();
      const height = window.visualViewport?.height || window.innerHeight;
      const top = window.visualViewport?.offsetTop || 0;
      const width = Math.min(380, document.documentElement.clientWidth - 16);
      const below = top + height - rect.bottom - 8;
      const above = rect.top - top - 8;
      const upward = below < 250 && above > below;
      setPosition({
        position: "fixed",
        width,
        left: Math.max(
          8,
          Math.min(rect.left, document.documentElement.clientWidth - width - 8),
        ),
        top: upward ? rect.top - 4 : rect.bottom + 4,
        maxHeight: Math.max(120, Math.min(440, upward ? above : below)),
        transform: upward ? "translateY(-100%)" : undefined,
      });
    };
    update();
    search.current?.focus();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !button.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="button secondary compact account-filter-trigger"
        aria-label={
          value.length
            ? `Accounts: ${value.length} selected`
            : "Accounts: all accounts"
        }
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Accounts{" "}
        <span>
          {value.length ? `${value.length} selected` : "All accounts"}
        </span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            id={panelId}
            ref={panel}
            className="account-filter-panel"
            style={position}
            role="group"
            aria-label="Filter by accounts"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                button.current?.focus();
              }
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget &&
                !panel.current?.contains(event.relatedTarget as Node) &&
                event.relatedTarget !== button.current
              )
                close();
            }}
          >
            <div className="account-filter-heading">
              <strong>Accounts</strong>
              <button
                type="button"
                className="text-button"
                disabled={!value.length || disabled}
                onClick={() => onChange([])}
              >
                Clear all
              </button>
            </div>
            <label className="account-filter-search">
              <Search size={15} />
              <input
                ref={search}
                type="search"
                aria-label="Search accounts"
                placeholder="Search name, code, or currency…"
                value={query}
                disabled={disabled}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <p className="account-filter-hint">
              Match any selected account. Leave all unchecked to show all
              accounts.
            </p>
            <div className="account-filter-options">
              {filtered.map((account) => (
                <label className="account-filter-option" key={account.id}>
                  <input
                    type="checkbox"
                    checked={selected.has(account.id)}
                    disabled={disabled}
                    onChange={() =>
                      onChange(
                        selected.has(account.id)
                          ? value.filter((id) => id !== account.id)
                          : [...value, account.id],
                      )
                    }
                  />
                  <span>
                    <span className="account-filter-name">
                      {account.name}
                      {!account.active && <em>Inactive</em>}
                    </span>
                    <small>
                      {account.code} · {account.currency}
                    </small>
                  </span>
                </label>
              ))}
              {!filtered.length && (
                <p className="account-filter-empty" role="status">
                  No matching accounts
                </p>
              )}
            </div>
            <div className="account-filter-footer">
              <span>
                {value.length} selected · {filtered.length} accounts shown
              </span>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  close();
                  button.current?.focus();
                }}
              >
                Done
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
