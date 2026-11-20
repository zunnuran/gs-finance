import assert from "node:assert/strict";
import { test } from "node:test";
import { periodStatementRows } from "../client/src/periodStatements";
import { sortRows } from "../client/src/tableSort";

const meta = {
  account_id: 1,
  account_name: "Bank",
  currency: "PKR",
  purpose: "bank",
};
const from = "2026-11-01",
  to = "2026-11-30";

test("statements reconcile brought-forward funds and chronological movement without mutating activity", () => {
  const activity = [
    {
      ...meta,
      id: 20,
      journal_id: 10,
      date: "2026-11-20",
      description: "Expense",
      debit: "0",
      credit: "15000",
      foreign_amount: "-15000",
    },
    {
      ...meta,
      id: 2,
      journal_id: 1,
      date: "2026-11-05",
      description: "Receipt",
      debit: "20000",
      credit: "0",
      foreign_amount: "20000",
    },
  ];
  const rows = periodStatementRows(
    [{ ...meta, opening: "50000", nominal_opening: "50000" }],
    activity,
    from,
    to,
  );
  assert.deepEqual(
    rows.map((row) => row.running_balance),
    ["50000.00", "70000.00", "55000.00", "55000.00"],
  );
  assert.deepEqual(
    rows.map((row) => row.nominal_balance),
    ["50000.00", "70000.00", "55000.00", "55000.00"],
  );
  assert.equal(rows[0].summary_kind, "opening");
  assert.equal(rows.at(-1)?.summary_kind, "closing");
  assert.equal(rows[0].date, from);
  assert.equal(rows.at(-1)?.date, to);
  assert.equal(activity[0].id, 20);
  const sorted = sortRows(
    rows.filter((row) => !row.summary_kind),
    (row) => row.date,
    "desc",
    "date",
  );
  assert.equal(
    sorted[0].running_balance,
    "55000.00",
    "display sorting does not recompute running balances",
  );
});

test("an idle period retains balances and carries them into the next statement", () => {
  const rows = periodStatementRows(
    [{ ...meta, opening: "55000", nominal_opening: "55000" }],
    [],
    "2026-12-01",
    "2026-12-31",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].running_balance, "55000.00");
  assert.equal(rows[1].running_balance, "55000.00");
  assert.deepEqual(
    periodStatementRows(
      [{ ...meta, opening: "0", nominal_opening: "0" }],
      [],
      from,
      to,
    ),
    [],
  );
});

test("credit balances, journal order and reversal amounts retain exact cents", () => {
  const rows = periodStatementRows(
    [{ ...meta, opening: "-9007199254740992.02", nominal_opening: "0" }],
    [
      {
        ...meta,
        id: 8,
        journal_id: 4,
        date: from,
        debit: "0.01",
        credit: "0",
        foreign_amount: "0",
        reversal_of: 1,
        description: "Correction",
      },
      {
        ...meta,
        id: 4,
        journal_id: 2,
        date: from,
        debit: "0",
        credit: "0.01",
        foreign_amount: "0",
      },
    ],
    from,
    to,
  );
  assert.equal(rows[1].id, 4);
  assert.equal(rows[1].running_balance, "-9007199254740992.03");
  assert.equal(rows[2].description, "Reversal · Correction");
  assert.equal(rows[3].running_balance, "-9007199254740992.02");
});

test("contact and currency statements never combine different debtors or currencies", () => {
  const openings = [
    {
      ...meta,
      contact_id: 1,
      contact_name: "Client A",
      currency: "USD",
      opening: "28000",
      nominal_opening: "100",
    },
    {
      ...meta,
      contact_id: 2,
      contact_name: "Client B",
      currency: "USD",
      opening: "14000",
      nominal_opening: "50",
    },
    {
      ...meta,
      contact_id: 1,
      contact_name: "Client A",
      currency: "EUR",
      opening: "30000",
      nominal_opening: "100",
    },
  ];
  const activity = [
    {
      ...meta,
      contact_id: 1,
      contact_name: "Client A",
      currency: "USD",
      id: 1,
      journal_id: 1,
      date: from,
      debit: "0",
      credit: "2800",
      foreign_amount: "-10",
    },
  ];
  const rows = periodStatementRows(openings, activity, from, to, true);
  const closing = rows.filter((row) => row.summary_kind === "closing");
  assert.equal(closing.length, 3);
  assert.equal(
    closing.find((row) => row.contact_id === 1 && row.currency === "USD")
      ?.nominal_balance,
    "90.00",
  );
  assert.equal(
    closing.find((row) => row.contact_id === 2)?.nominal_balance,
    "50.00",
  );
  assert.equal(
    closing.find((row) => row.currency === "EUR")?.running_balance,
    "30000.00",
  );
  assert.equal(new Set(closing.map((row) => row.statement_group)).size, 3);
});

test("general-ledger account statements combine contacts but keep accounts separate", () => {
  const rows = periodStatementRows(
    [
      { ...meta, contact_id: 1, opening: "100", nominal_opening: "100" },
      { ...meta, contact_id: 2, opening: "200", nominal_opening: "200" },
      {
        ...meta,
        account_id: 2,
        account_name: "Cash",
        opening: "500",
        nominal_opening: "500",
      },
    ],
    [],
    from,
    to,
  );
  assert.deepEqual(
    rows
      .filter((row) => row.summary_kind === "closing")
      .map((row) => row.running_balance),
    ["300.00", "500.00"],
  );
});
