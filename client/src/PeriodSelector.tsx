import { useEffect, useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { SearchableSelect } from "./SearchableSelect";
import {
  defaultPeriod,
  resolvePeriod,
  type PeriodSelection,
} from "../../shared/period";

export function useFinancialPeriod(
  userId: number | undefined,
  company: number,
  enabled: boolean,
) {
  const key = `gss-finance-period-v1-${userId}-${company}`;
  const saved = useMemo(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      if (value) {
        resolvePeriod(value);
        return value as PeriodSelection;
      }
    } catch {
      /* Invalid or unavailable preferences use the current PKT month. */
    }
    return defaultPeriod();
  }, [key]);
  const [choice, setChoice] = useState<{
    key: string;
    value: PeriodSelection;
  } | null>(null);
  const value = choice?.key === key ? choice.value : saved;
  const period = useMemo(
    () => (enabled && company ? resolvePeriod(value) : null),
    [enabled, company, value],
  );
  const change = (next: PeriodSelection) => {
    resolvePeriod(next);
    setChoice({ key, value: next });
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* Optional preference. */
    }
  };
  return { value, period, change };
}

export function PeriodSelector({
  value,
  onChange,
}: {
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(value);
    setError("");
  }, [value]);
  const selected = resolvePeriod(value);
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: new Date(2026, i, 1).toLocaleDateString("en-GB", { month: "long" }),
  }));
  return (
    <section className="period-selector" aria-label="Financial period">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          try {
            resolvePeriod(draft);
            onChange(draft);
            setError("");
          } catch (reason) {
            setError((reason as Error).message);
          }
        }}
      >
        <span className="period-selector-label">
          <CalendarDays size={17} /> Period
        </span>
        <SearchableSelect
          aria-label="Period type"
          value={draft.mode}
          onChange={(mode) => {
            const year = Number(selected.from.slice(0, 4));
            const month = Number(selected.from.slice(5, 7));
            setDraft({
              mode: mode as PeriodSelection["mode"],
              year: mode === "financial_year" && month < 7 ? year - 1 : year,
              month,
              from: selected.from,
              to: selected.to,
            });
          }}
          options={[
            { value: "month", label: "Month" },
            { value: "calendar_year", label: "Calendar year" },
            { value: "financial_year", label: "Financial year (Jul–Jun)" },
            { value: "custom", label: "Custom dates" },
          ]}
        />
        {draft.mode === "month" && (
          <SearchableSelect
            aria-label="Month"
            value={draft.month ?? 1}
            onChange={(month) => setDraft({ ...draft, month: Number(month) })}
            options={months}
          />
        )}
        {draft.mode !== "custom" ? (
          <label className="period-year">
            {draft.mode === "financial_year" ? "Starting year" : "Year"}
            <input
              aria-label={
                draft.mode === "financial_year"
                  ? "Financial year starting year"
                  : "Year"
              }
              type="number"
              min="1900"
              max="9998"
              required
              value={draft.year ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, year: Number(event.target.value) })
              }
            />
          </label>
        ) : (
          <>
            <label>
              From
              <input
                aria-label="Period from date"
                type="date"
                required
                value={draft.from || ""}
                onChange={(event) =>
                  setDraft({ ...draft, from: event.target.value })
                }
              />
            </label>
            <label>
              To
              <input
                aria-label="Period to date"
                type="date"
                required
                value={draft.to || ""}
                onChange={(event) =>
                  setDraft({ ...draft, to: event.target.value })
                }
              />
            </label>
          </>
        )}
        <button type="submit" className="button compact">
          Apply period
        </button>
      </form>
      <div className="period-caption">
        <strong>{selected.label}</strong>
        <span>
          {selected.from} — {selected.to}
        </span>
        <span>Activity during this period · Balances as of {selected.to}</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
