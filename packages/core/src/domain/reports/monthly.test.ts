import { describe, expect, it } from "vitest";

import {
  addMonths,
  formatMonth,
  formatMonthTitle,
  isCurrentMonth,
  monthlyRecommendationPeriod,
  monthlyReportRange,
  parseReportMonth,
  reportMonths,
} from "./monthly";

describe("report months", () => {
  it("moves across years", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-11", -12)).toBe("2025-11");
  });

  it("names a month in Spanish", () => {
    expect(formatMonth("2026-10")).toBe("octubre de 2026");
    expect(formatMonthTitle("2026-01")).toBe("Enero de 2026");
  });

  it("defaults to the month that ended, and refuses the future and the far past", () => {
    expect(parseReportMonth(undefined, "2026-11-12")).toBe("2026-10");
    expect(parseReportMonth("2026-11", "2026-11-12")).toBe("2026-11");
    expect(parseReportMonth("2026-12", "2026-11-12")).toBe("2026-10");
    expect(parseReportMonth("2025-10", "2026-11-12")).toBe("2026-10");
    expect(parseReportMonth("2025-11", "2026-11-12")).toBe("2025-11");
    expect(parseReportMonth("2026-13", "2026-11-12")).toBe("2026-10");
    expect(parseReportMonth("2026-1", "2026-11-12")).toBe("2026-10");
  });

  it("offers this month and the twelve before, newest first", () => {
    const months = reportMonths("2026-01-05");
    expect(months).toHaveLength(13);
    expect(months[0]).toBe("2026-01");
    expect(months[12]).toBe("2025-01");
  });
});

describe("monthlyReportRange", () => {
  it("covers a whole month that ended, against the whole month before", () => {
    const range = monthlyReportRange("2026-03", "2026-11-12");
    expect(range).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(range.previous).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("the current month to today, against the same days of the month before", () => {
    const range = monthlyReportRange("2026-03", "2026-03-31");
    expect(range).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(range.previous).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthlyReportRange("2026-11", "2026-11-12").previous).toEqual({
      from: "2026-10-01",
      to: "2026-10-12",
    });
    expect(isCurrentMonth("2026-11", "2026-11-12")).toBe(true);
  });

  it("January against December", () => {
    expect(monthlyReportRange("2026-01", "2026-02-01").previous).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });

  it("refuses a month in the future", () => {
    expect(() => monthlyReportRange("2026-12", "2026-11-12")).toThrow();
  });

  it("names the period of the Copilot's facts", () => {
    expect(monthlyRecommendationPeriod("2026-10", "2026-11-01")).toEqual({
      name: "octubre de 2026",
      previous: "el mes anterior",
    });
    expect(monthlyRecommendationPeriod("2026-11", "2026-11-12")).toEqual({
      name: "noviembre de 2026, hasta hoy",
      previous: "los mismos días del mes anterior",
    });
  });
});
