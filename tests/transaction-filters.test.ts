import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterTransactionAccounts,
  formatTransactionAmount,
  summarizeTransactionAmounts,
} from "../client/src/transactionFilters";

test("account filtering matches either side of transfers once and preserves distinct reversal activity", () => {
  const rows = Object.freeze([
    {
      id: 1,
      activity_id: "document:1",
      account_ids: [10, 20],
      amount: "100.25",
      base_amount: "100.25",
      currency: "PKR",
    },
    {
      id: 1,
      activity_id: "reversal:2",
      account_ids: [10, 20],
      amount: "-100.25",
      base_amount: "-100.25",
      currency: "PKR",
    },
    {
      id: 3,
      activity_id: "document:3",
      account_ids: [30, 40],
      amount: "50.10",
      base_amount: "50.10",
      currency: "PKR",
    },
  ]);
  assert.deepEqual(
    filterTransactionAccounts(rows, [20]).map((row) => row.activity_id),
    ["document:1", "reversal:2"],
  );
  const matched = filterTransactionAccounts(rows, [10, 20, 10]);
  assert.equal(matched.length, 2);
  assert.equal(matched[0], rows[0]);
  assert.deepEqual(summarizeTransactionAmounts(matched), {
    count: 2,
    byCurrency: [{ currency: "PKR", amount: "0.00" }],
    baseAmount: "0.00",
  });
  assert.deepEqual(filterTransactionAccounts(rows, []), rows);
  assert.deepEqual(filterTransactionAccounts(rows, [999]), []);
  assert.equal(rows.length, 3);
});

test("totals preserve cents beyond the safe integer range and keep currencies separate", () => {
  const totals = summarizeTransactionAmounts([
    { currency: "USD", amount: "2.01", base_amount: "562.80" },
    {
      currency: "PKR",
      amount: "999999999999999999.99",
      base_amount: "999999999999999999.99",
    },
    { currency: "PKR", amount: "0.02", base_amount: "0.02" },
    { currency: "USD", amount: "-0.01", base_amount: "-2.80" },
    { currency: "EUR", amount: "0.10", base_amount: "30.00" },
  ]);
  assert.deepEqual(totals, {
    count: 5,
    byCurrency: [
      { currency: "EUR", amount: "0.10" },
      { currency: "PKR", amount: "1000000000000000000.01" },
      { currency: "USD", amount: "2.00" },
    ],
    baseAmount: "1000000000000000590.01",
  });
  assert.equal(
    formatTransactionAmount(totals.baseAmount),
    "1,000,000,000,000,000,590.01",
  );
});

test("totals include exactly the supplied filtered rows regardless of checkbox selection or visible columns", () => {
  const rows = [
    {
      status: "pending",
      currency: "PKR",
      amount: "20.01",
      base_amount: "20.01",
      account_ids: [1],
    },
    {
      status: "posted",
      currency: "PKR",
      amount: "3.02",
      base_amount: "3.02",
      account_ids: [2],
    },
    {
      status: "cancelled",
      currency: "PKR",
      amount: "4.03",
      base_amount: "4.03",
      account_ids: [1],
    },
  ];
  assert.equal(summarizeTransactionAmounts(rows).baseAmount, "27.06");
  assert.equal(
    summarizeTransactionAmounts(filterTransactionAccounts(rows, [1]))
      .baseAmount,
    "24.04",
  );
  assert.equal(
    summarizeTransactionAmounts(rows.filter((row) => row.status === "posted"))
      .baseAmount,
    "3.02",
  );
  assert.deepEqual(summarizeTransactionAmounts([]), {
    count: 0,
    byCurrency: [],
    baseAmount: "0.00",
  });
});
