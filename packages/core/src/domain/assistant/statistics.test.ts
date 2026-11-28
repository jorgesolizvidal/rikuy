import { describe, expect, it } from "vitest";

import { statisticsRange } from "../visits/statistics";
import { summarizeAssistant, type AssistantStatisticsData } from "./statistics";

const MUSEO = "5eed4100-0000-4000-8000-000000000001";

function data(
  from: string,
  to: string,
  portal: number,
  qr: number,
  since: string | null = "2026-10-01",
): AssistantStatisticsData {
  const row = (channel: "portal" | "qr", conversations: number) => ({
    channel,
    conversations,
    people: conversations,
    answered: conversations - 1,
    abstained: 1,
    plans: 0,
    notices: 0,
    askedPerson: channel === "qr" ? 1 : 0,
    withAction: 1,
  });
  return {
    from,
    to,
    since,
    channels: [row("portal", portal), row("qr", qr)].filter((item) => item.conversations > 0),
    topics: [
      {
        contentId: MUSEO,
        kind: "destination",
        slug: "museo",
        title: "Museo",
        published: true,
        times: 3,
        channels: { portal: 2, embed: 0, qr: 1, whatsapp: 0 },
      },
    ],
    actions: [
      { action: "map", times: 1, answers: 1 },
      { action: "place", times: 3, answers: 2 },
    ],
  };
}

describe("the assistant by channel (ADR-074)", () => {
  const range = statisticsRange("7-dias", "2026-11-12");

  it("adds the channels up and compares with the previous period", () => {
    const summary = summarizeAssistant(
      range,
      data(range.from, range.to, 6, 2),
      data(range.previous.from, range.previous.to, 2, 2),
    );
    expect(summary.compared).toBe(true);
    expect(summary.totals.conversations).toEqual({ value: 8, previous: 4, change: 1 });
    expect(summary.totals.askedPerson.value).toBe(1);
    expect(summary.channels.map((row) => [row.channel, row.share, row.name])).toEqual([
      ["portal", 75, "En el portal"],
      ["qr", 25, "Desde un QR «Pregúntale a…»"],
    ]);
    expect(summary.topics[0]).toMatchObject({ title: "Museo", kindName: "Destino", times: 3 });
    expect(summary.actions.map((row) => row.action)).toEqual(["place", "map"]);
    expect(summary.empty).toBe(false);
  });

  it("does not compare a period counted only in part", () => {
    const summary = summarizeAssistant(
      range,
      data(range.from, range.to, 1, 0, range.from),
      data(range.previous.from, range.previous.to, 0, 0, range.from),
    );
    expect(summary.compared).toBe(false);
    expect(summary.totals.conversations.previous).toBeNull();
  });

  it("is empty when nobody asked", () => {
    const summary = summarizeAssistant(
      range,
      { ...data(range.from, range.to, 0, 0), topics: [], actions: [] },
      null,
    );
    expect(summary.empty).toBe(true);
    expect(summary.channels).toEqual([]);
  });
});
