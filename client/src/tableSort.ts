import Decimal from "decimal.js";

export type SortDirection = "asc" | "desc";
export type SortType = "text" | "number" | "date";
export type SortValue = string | number | null | undefined;
export type SortState = { key: string; direction: SortDirection };

const textOrder = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function nextSort(
  current: SortState | null,
  key: string,
  firstDirection: SortDirection = "asc",
): SortState {
  return {
    key,
    direction:
      current?.key === key
        ? current.direction === "asc"
          ? "desc"
          : "asc"
        : firstDirection,
  };
}

function comparable(
  value: SortValue,
  type: SortType,
): string | Decimal | number | null {
  if (value == null || (typeof value === "number" && !Number.isFinite(value)))
    return null;
  const text = String(value).trim();
  if (!text || text === "—" || text === "–") return null;
  if (type === "number") {
    try {
      const number = new Decimal(value);
      return number.isFinite() ? number : null;
    } catch {
      return null;
    }
  }
  if (type === "date") {
    const time = typeof value === "number" ? value : Date.parse(text);
    return Number.isFinite(time) ? time : null;
  }
  return text;
}

/** Sort raw values without changing source rows; blanks stay last in either direction. */
export function sortRows<T>(
  rows: readonly T[],
  getValue: (row: T) => SortValue,
  direction: SortDirection,
  type: SortType = "text",
): T[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({
      row,
      index,
      value: comparable(getValue(row), type),
    }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const compared =
        type === "number"
          ? (a.value as Decimal).comparedTo(b.value as Decimal)
          : type === "date"
            ? (a.value as number) - (b.value as number)
            : textOrder.compare(a.value as string, b.value as string);
      return compared * multiplier || a.index - b.index;
    })
    .map(({ row }) => row);
}
