import Decimal from "decimal.js";

type Row = Record<string, any>;
const Exact = Decimal.clone({ precision: 40 });

/** Build statement balances before display sorting; currencies never share a running total. */
export function periodStatementRows(
  openings: Row[],
  activity: Row[],
  from: string,
  to: string,
  byContact = false,
): Row[] {
  const groups = new Map<
    string,
    { metadata: Row; opening: Decimal; nominal: Decimal; lines: Row[] }
  >();
  const groupFor = (row: Row) => {
    const key = JSON.stringify([
      row.account_id,
      byContact ? (row.contact_id ?? null) : null,
      row.currency || "PKR",
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        metadata: { ...row, statement_group: key },
        opening: new Exact(0),
        nominal: new Exact(0),
        lines: [],
      };
      groups.set(key, group);
    }
    return group;
  };
  for (const row of openings) {
    const group = groupFor(row);
    group.opening = group.opening.plus(row.opening || 0);
    group.nominal = group.nominal.plus(row.nominal_opening || 0);
  }
  for (const row of activity) groupFor(row).lines.push(row);
  const result: Row[] = [];
  const ordered = [...groups.values()].sort(
    (a, b) =>
      String(a.metadata.account_name || "").localeCompare(
        String(b.metadata.account_name || ""),
        "en",
        { numeric: true },
      ) ||
      Number(a.metadata.account_id) - Number(b.metadata.account_id) ||
      String(
        byContact ? a.metadata.contact_name || a.metadata.contact_id || "" : "",
      ).localeCompare(
        String(
          byContact
            ? b.metadata.contact_name || b.metadata.contact_id || ""
            : "",
        ),
        "en",
        { numeric: true },
      ) ||
      String(a.metadata.currency || "PKR").localeCompare(
        String(b.metadata.currency || "PKR"),
      ),
  );
  for (const group of ordered) {
    if (!group.lines.length && group.opening.isZero() && group.nominal.isZero())
      continue;
    const metadata = group.metadata;
    const common = {
      statement_group: metadata.statement_group,
      account_id: metadata.account_id,
      account_name: metadata.account_name,
      account_code: metadata.account_code || metadata.code,
      contact_id: byContact ? metadata.contact_id : null,
      contact_name: byContact ? metadata.contact_name : null,
      currency: metadata.currency || "PKR",
    };
    let balance = group.opening;
    let nominal = group.nominal;
    result.push({
      ...common,
      id: `${metadata.statement_group}:opening`,
      summary_kind: "opening",
      date: from,
      description: "B/F — brought forward",
      running_balance: balance.toFixed(2),
      nominal_balance: nominal.toFixed(2),
    });
    const lines = [...group.lines].sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        Number(a.journal_id) - Number(b.journal_id) ||
        Number(a.id) - Number(b.id),
    );
    for (const line of lines) {
      balance = balance.plus(line.debit || 0).minus(line.credit || 0);
      nominal = nominal.plus(line.foreign_amount || 0);
      result.push({
        ...line,
        statement_group: metadata.statement_group,
        currency: common.currency,
        description: `${line.reversal_of ? "Reversal · " : ""}${line.description || ""}`,
        running_balance: balance.toFixed(2),
        nominal_movement: new Exact(line.foreign_amount || 0).toFixed(2),
        nominal_balance: nominal.toFixed(2),
      });
    }
    result.push({
      ...common,
      id: `${metadata.statement_group}:closing`,
      summary_kind: "closing",
      date: to,
      description: "C/F — carried forward",
      running_balance: balance.toFixed(2),
      nominal_balance: nominal.toFixed(2),
    });
  }
  return result;
}
