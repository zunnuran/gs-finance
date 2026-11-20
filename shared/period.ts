export type PeriodMode =
  "month" | "calendar_year" | "financial_year" | "custom";
export type PeriodSelection = {
  mode: PeriodMode;
  year?: number;
  month?: number;
  from?: string;
  to?: string;
};
export type ResolvedPeriod = {
  mode: PeriodMode;
  from: string;
  to: string;
  label: string;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function integer(value: unknown, min: number, max: number, name: string) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return invalid(`Choose a valid ${name}`);
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max)
    return invalid(`Choose a valid ${name}`);
  return result;
}
export function pakistanToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function defaultPeriod(now = new Date()): PeriodSelection {
  const [year, month] = pakistanToday(now).split("-").map(Number);
  return { mode: "month", year, month };
}
function validDay(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value.startsWith("0000")
  )
    invalid("Choose a valid date");
  return value as string;
}
export function resolvePeriod(selection: PeriodSelection): ResolvedPeriod {
  if (!selection || typeof selection !== "object")
    return invalid("Choose a period");
  const { mode } = selection;
  if (mode === "custom") {
    const from = validDay(selection.from),
      to = validDay(selection.to);
    if (from > to) invalid("Start date must precede end date");
    return { mode, from, to, label: "Custom dates" };
  }
  if (!["month", "calendar_year", "financial_year"].includes(mode))
    return invalid("Choose a valid period type");
  const year = integer(
    selection.year,
    1,
    mode === "financial_year" ? 9998 : 9999,
    "year",
  );
  const y = String(year).padStart(4, "0");
  if (mode === "calendar_year")
    return {
      mode,
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      label: `Calendar year ${y}`,
    };
  if (mode === "financial_year")
    return {
      mode,
      from: `${y}-07-01`,
      to: `${String(year + 1).padStart(4, "0")}-06-30`,
      label: `FY ${y}–${String(year + 1).slice(-2)}`,
    };
  const month = integer(selection.month, 1, 12, "month");
  const m = String(month).padStart(2, "0");
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  const from = `${y}-${m}-01`;
  return {
    mode,
    from,
    to: `${y}-${m}-${days}`,
    label: new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${from}T12:00:00Z`)),
  };
}
export function periodQuery(selection: PeriodSelection) {
  resolvePeriod(selection);
  const params = new URLSearchParams({ period: selection.mode });
  if (selection.mode === "custom") {
    params.set("from", selection.from!);
    params.set("to", selection.to!);
  } else {
    params.set("year", String(selection.year));
    if (selection.mode === "month")
      params.set("month", String(selection.month));
  }
  return params.toString();
}
export function periodFromQuery(
  query: Record<string, unknown>,
): ResolvedPeriod | null {
  if (query.period === undefined) return null;
  return resolvePeriod({
    mode: query.period as PeriodMode,
    year: query.year as number,
    month: query.month as number,
    from: query.from as string,
    to: query.to as string,
  });
}
