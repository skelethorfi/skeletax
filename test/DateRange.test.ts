import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dateIn, generateDateRanges, nextDay, startOfDay } from "../src/utils/DateRange.ts";

describe("generateDateRanges", () => {
  test("should throw if no fromDate is provided", () => {
    assert.throws(() => generateDateRanges(undefined as any, "2025-01-01", "monthly"), /Invalid fromDate/);
  });

  test("should throw if no toDate is provided", () => {
    assert.throws(() => generateDateRanges("2025-01-01", undefined as any, "monthly"), /Invalid toDate/);
  });

  test("should throw if fromDate is later than toDate", () => {
    assert.throws(
      () => generateDateRanges("2025-05-01", "2025-01-01", "monthly"),
      /fromDate must be earlier than toDate/,
    );
  });

  test("should throw if fromDate is invalid", () => {
    assert.throws(() => generateDateRanges("not-a-date", "2025-01-01", "monthly"), /Invalid fromDate/);
  });

  test("should throw on a date that is not on the calendar", () => {
    assert.throws(() => generateDateRanges("2023-02-30", "2023-12-31", "monthly"), /Invalid fromDate/);
    assert.throws(() => generateDateRanges("2023-01-01", "2023-04-31", "monthly"), /Invalid toDate/);
  });

  test("should throw on an unknown frequency", () => {
    assert.throws(() => generateDateRanges("2023-01-01", "2023-12-31", "annually" as any), /Unknown frequency/);
  });

  test("should throw if toDate is invalid", () => {
    assert.throws(() => generateDateRanges("2025-01-01", "not-a-date", "monthly"), /Invalid toDate/);
  });

  test("should return a single range when frequency is 'none'", () => {
    const ranges = generateDateRanges("2025-01-01", "2025-01-10", "none");
    assert.deepEqual(ranges, [{ from: "2025-01-01", to: "2025-01-10" }]);
  });

  test("should generate monthly ranges", () => {
    const ranges = generateDateRanges("2025-01-01", "2025-03-31", "monthly");
    assert.deepEqual(ranges, [
      { from: "2025-01-01", to: "2025-01-31" },
      { from: "2025-02-01", to: "2025-02-28" },
      { from: "2025-03-01", to: "2025-03-31" },
    ]);
  });

  test("should handle end-of-month start dates correctly", () => {
    const ranges = generateDateRanges("2025-01-31", "2025-03-15", "monthly");
    assert.deepEqual(ranges, [
      { from: "2025-01-31", to: "2025-01-31" },
      { from: "2025-02-01", to: "2025-02-28" },
      { from: "2025-03-01", to: "2025-03-15" },
    ]);
  });

  test("should give February 29 days in a leap year", () => {
    const ranges = generateDateRanges("2020-01-01", "2020-03-31", "monthly");
    assert.deepEqual(ranges, [
      { from: "2020-01-01", to: "2020-01-31" },
      { from: "2020-02-01", to: "2020-02-29" },
      { from: "2020-03-01", to: "2020-03-31" },
    ]);
  });

  test("should generate yearly ranges as 12-month blocks from start date", () => {
    const ranges = generateDateRanges("2024-07-01", "2026-02-15", "yearly");
    assert.deepEqual(ranges, [
      { from: "2024-07-01", to: "2025-06-30" },
      { from: "2025-07-01", to: "2026-02-15" },
    ]);
  });

  test("should handle end-of-month start dates correctly for yearly", () => {
    const ranges = generateDateRanges("2025-01-31", "2026-03-15", "yearly");
    assert.deepEqual(ranges, [
      { from: "2025-01-31", to: "2026-01-30" },
      { from: "2026-01-31", to: "2026-03-15" },
    ]);
  });

  test("should handle leap year correctly in yearly ranges", () => {
    const ranges = generateDateRanges("2023-03-01", "2024-08-15", "yearly");
    assert.deepEqual(ranges, [
      { from: "2023-03-01", to: "2024-02-29" }, // 2024 is leap year
      { from: "2024-03-01", to: "2024-08-15" },
    ]);
  });

  test("should handle multiple full 12-month blocks", () => {
    const ranges = generateDateRanges("2020-05-10", "2023-07-05", "yearly");
    assert.deepEqual(ranges, [
      { from: "2020-05-10", to: "2021-05-09" },
      { from: "2021-05-10", to: "2022-05-09" },
      { from: "2022-05-10", to: "2023-05-09" },
      { from: "2023-05-10", to: "2023-07-05" }, // partial final period
    ]);
  });
});

describe("time zones", () => {
  test("startOfDay gives local midnight, in or out of daylight saving", () => {
    assert.equal(new Date(startOfDay("2025-07-01")).toISOString(), "2025-07-01T00:00:00.000Z");
    assert.equal(new Date(startOfDay("2025-07-01", "Asia/Tokyo")).toISOString(), "2025-06-30T15:00:00.000Z");
    assert.equal(new Date(startOfDay("2025-07-01", "America/New_York")).toISOString(), "2025-07-01T04:00:00.000Z");
    assert.equal(new Date(startOfDay("2026-01-01", "America/New_York")).toISOString(), "2026-01-01T05:00:00.000Z");
    // the days daylight saving starts and ends in New York (the change is at 2 am)
    assert.equal(new Date(startOfDay("2025-03-09", "America/New_York")).toISOString(), "2025-03-09T05:00:00.000Z");
    assert.equal(new Date(startOfDay("2025-11-02", "America/New_York")).toISOString(), "2025-11-02T04:00:00.000Z");
  });

  test("nextDay crosses month and year ends", () => {
    assert.equal(nextDay("2025-06-30"), "2025-07-01");
    assert.equal(nextDay("2024-02-28"), "2024-02-29");
    assert.equal(nextDay("2025-12-31"), "2026-01-01");
  });

  test("dateIn gives the calendar date in the zone", () => {
    assert.equal(dateIn(new Date("2025-06-30T19:30:00.000Z")), "2025-06-30");
    assert.equal(dateIn(new Date("2025-06-30T19:30:00.000Z"), "Asia/Tokyo"), "2025-07-01");
  });
});
