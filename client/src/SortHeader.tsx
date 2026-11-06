import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { SortState } from "./tableSort";

export function SortHeader({
  label,
  column,
  sort,
  onSort,
  className = "",
  disabled = false,
  numeric = false,
}: {
  label: string;
  column: string;
  sort: SortState | null;
  onSort: (key: string) => void;
  className?: string;
  disabled?: boolean;
  numeric?: boolean;
}) {
  const active = sort?.key === column;
  const nextDirection =
    active && sort.direction === "asc" ? "descending" : "ascending";
  const Icon = active
    ? sort.direction === "asc"
      ? ArrowUp
      : ArrowDown
    : ArrowUpDown;
  return (
    <th
      scope="col"
      className={`${className} ${numeric ? "align-right" : ""}`.trim()}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      <button
        type="button"
        className={`table-sort-button${active ? " is-sorted" : ""}`}
        onClick={() => onSort(column)}
        disabled={disabled}
        aria-label={`${label}: sort ${nextDirection}`}
        title={`Sort ${label.toLowerCase()} ${nextDirection}`}
      >
        <span>{label}</span>
        <Icon size={13} aria-hidden="true" />
      </button>
    </th>
  );
}
