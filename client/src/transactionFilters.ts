import Decimal from "decimal.js";

const TotalDecimal = Decimal.clone({ precision: 40 });

export function filterTransactionAccounts<
  T extends { account_ids?: readonly number[] },
>(rows: readonly T[], accountIds: readonly number[]): T[] {
  if (!accountIds.length) return [...rows];
  const selected = new Set(accountIds);
  return rows.filter((row) => row.account_ids?.some((id) => selected.has(id)));
}

export function summarizeTransactionAmounts(
  rows: readonly {
    amount?: Decimal.Value;
    base_amount?: Decimal.Value;
    currency?: string;
  }[],
) {
  const currencies = new Map<string, Decimal>();
  let base = new TotalDecimal(0);
  for (const row of rows) {
    const currency = row.currency || "—";
    currencies.set(
      currency,
      (currencies.get(currency) || new TotalDecimal(0)).plus(row.amount ?? 0),
    );
    base = base.plus(row.base_amount ?? 0);
  }
  return {
    count: rows.length,
    byCurrency: [...currencies]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, total]) => ({ currency, amount: total.toFixed(2) })),
    baseAmount: base.toFixed(2),
  };
}

export const formatTransactionAmount = (value: Decimal.Value) =>
  new TotalDecimal(value).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
