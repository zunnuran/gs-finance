import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSort, sortRows } from "../client/src/tableSort";

test("amounts sort numerically in both directions, preserving small decimal differences", () => {
  const amounts = [
    "1000",
    "9.50",
    "10.00",
    "-2",
    "9007199254740992.02",
    "9007199254740992.01",
  ];
  const expected = [
    "-2",
    "9.50",
    "10.00",
    "1000",
    "9007199254740992.01",
    "9007199254740992.02",
  ];
  assert.deepEqual(
    sortRows(amounts, (v) => v, "asc", "number"),
    expected,
  );
  assert.deepEqual(
    sortRows(amounts, (v) => v, "desc", "number"),
    [...expected].reverse(),
  );
});

test("dates sort by actual time across months, years, and timezone offsets", () => {
  const dates = [
    "2026-11-01",
    "2025-12-31",
    "2026-10-01T01:00:00+05:00",
    "2026-09-30T21:00:00Z",
  ];
  const expected = [dates[1], dates[2], dates[3], dates[0]];
  assert.deepEqual(
    sortRows(dates, (v) => v, "asc", "date"),
    expected,
  );
  assert.deepEqual(
    sortRows(dates, (v) => v, "desc", "date"),
    [...expected].reverse(),
  );
});

test("empty and invalid values stay last in either direction while zero remains a value", () => {
  const values = [null, "2", "", "—", "0", undefined, "bad number", NaN];
  const empty = [null, "", "—", undefined, "bad number", NaN];
  assert.deepEqual(
    sortRows(values, (v) => v, "asc", "number"),
    ["0", "2", ...empty],
  );
  assert.deepEqual(
    sortRows(values, (v) => v, "desc", "number"),
    ["2", "0", ...empty],
  );
  assert.deepEqual(
    sortRows([null, "bad date", "2026-01-01"], (v) => v, "desc", "date"),
    ["2026-01-01", null, "bad date"],
  );
});

test("text uses natural alphabetical order and ignores case", () => {
  assert.deepEqual(
    sortRows(["Bank 10", "bank 2", "Admin", "—"], (v) => v, "asc"),
    ["Admin", "bank 2", "Bank 10", "—"],
  );
});

test("sorting is stable and leaves original rows and selection identities untouched", () => {
  const rows = Object.freeze([
    { id: 3, amount: "10" },
    { id: 1, amount: "2" },
    { id: 2, amount: "10.00" },
  ]);
  const selected = new Set([3, 1]);
  const ordered = sortRows(rows, (r) => r.amount, "asc", "number");
  assert.deepEqual(
    ordered.map((r) => r.id),
    [1, 3, 2],
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    [3, 1, 2],
  );
  assert.equal(ordered[1], rows[0]);
  assert.deepEqual(
    ordered.filter((r) => selected.has(r.id)).map((r) => r.id),
    [1, 3],
  );
  assert.deepEqual(
    sortRows(rows, (r) => r.amount, "desc", "number").map((r) => r.id),
    [3, 2, 1],
  );
});

test("header selection toggles ascending and descending and resets for another column", () => {
  assert.deepEqual(nextSort(null, "amount"), {
    key: "amount",
    direction: "asc",
  });
  assert.deepEqual(nextSort({ key: "amount", direction: "asc" }, "amount"), {
    key: "amount",
    direction: "desc",
  });
  assert.deepEqual(nextSort({ key: "amount", direction: "desc" }, "amount"), {
    key: "amount",
    direction: "asc",
  });
  assert.deepEqual(nextSort({ key: "amount", direction: "desc" }, "date"), {
    key: "date",
    direction: "asc",
  });
});
