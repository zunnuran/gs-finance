import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPeriod,
  currentMonthPeriod,
  periodFromQuery,
  periodQuery,
  resolvePeriod,
} from "../shared/period";
import { roleDefaults } from "../shared/permissions";

test("period resolver uses complete months including leap and century boundaries", () => {
  assert.equal(
    resolvePeriod({ mode: "month", year: 2024, month: 2 }).to,
    "2024-02-29",
  );
  assert.equal(
    resolvePeriod({ mode: "month", year: 2100, month: 2 }).to,
    "2100-02-28",
  );
  assert.equal(
    resolvePeriod({ mode: "month", year: 2000, month: 2 }).to,
    "2000-02-29",
  );
  assert.deepEqual(resolvePeriod({ mode: "month", year: 2026, month: 11 }), {
    mode: "month",
    from: "2026-11-01",
    to: "2026-11-30",
    label: "November 2026",
  });
});
test("annual periods cover calendar and July–June boundaries inclusively", () => {
  const calendar = resolvePeriod({ mode: "calendar_year", year: 2026 });
  assert.equal(calendar.from, "2026-01-01");
  assert.equal(calendar.to, "2026-12-31");
  assert.deepEqual(resolvePeriod({ mode: "financial_year", year: 2026 }), {
    mode: "financial_year",
    from: "2026-07-01",
    to: "2027-06-30",
    label: "FY 2026–27",
  });
  assert.equal(
    resolvePeriod({ mode: "month", year: 2027, month: 1 }).from,
    "2027-01-01",
  );
});
test("the default is unfiltered and all-data requests carry no stale date parameters", () => {
  assert.deepEqual(defaultPeriod(), { mode: "all" });
  assert.equal(
    periodQuery({
      mode: "all",
      year: 2026,
      month: 11,
      from: "2026-11-01",
      to: "2026-11-30",
    }),
    "period=all",
  );
  assert.deepEqual(periodFromQuery({ period: "all" }), {
    mode: "all",
    from: "0001-01-01",
    to: "9999-12-31",
    label: "All data",
  });
});
test("the month picker uses Pakistan time even across a UTC year boundary", () => {
  assert.deepEqual(currentMonthPeriod(new Date("2026-12-31T20:00:00Z")), {
    mode: "month",
    year: 2027,
    month: 1,
  });
  assert.deepEqual(currentMonthPeriod(new Date("2026-06-30T20:00:00Z")), {
    mode: "month",
    year: 2026,
    month: 7,
  });
});
test("period requests round-trip and reject malformed dates, modes and scalar values", () => {
  const selected = { mode: "month" as const, year: 2026, month: 11 };
  assert.equal(periodQuery(selected), "period=month&year=2026&month=11");
  assert.deepEqual(
    periodFromQuery(
      Object.fromEntries(new URLSearchParams(periodQuery(selected))),
    ),
    resolvePeriod(selected),
  );
  assert.equal(periodFromQuery({ from: "2026-01-01" }), null);
  assert.equal(
    resolvePeriod({ mode: "custom", from: "2026-11-15", to: "2026-11-15" }).to,
    "2026-11-15",
  );
  for (const query of [
    { period: "month", year: "2026", month: "13" },
    { period: "month", year: ["2026"], month: "1" },
    { period: ["month"], year: "2026", month: "1" },
    { period: "financial_year", year: "9999" },
    { period: "custom", from: "2026-02-30", to: "2026-03-01" },
    { period: "custom", from: "2026-11-15", to: "2026-11-14" },
    { period: "unknown", year: "2026" },
  ])
    assert.throws(
      () => periodFromQuery(query),
      (error) => (error as any).status === 400,
    );
});
test("shared period permission is opt-in for every staff role", () => {
  for (const [role, permissions] of Object.entries(roleDefaults))
    assert.equal(
      permissions.includes("transactions.view_periods"),
      role === "super_admin",
    );
});
