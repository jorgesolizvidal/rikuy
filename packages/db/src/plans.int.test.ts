/**
 * Plans of the visitor's assistant (P5 · Paso 4, ADR-039) with the portal's REAL reads:
 * published destinations with their opening hours and the upcoming events of Demo Norte
 * (anonymous, through PostgREST). The seed has an event that already ended next to the
 * square («Festival de invierno»): no plan recommends it, even when the phone says it is
 * the closest place. The model is the simulated one, without the gateway's ledger (nothing
 * is written for Demo Norte, which RC-15 reads).
 */
import {
  askAssistant,
  createSimulatedAiProvider,
  defaultPresentation,
  loadAssistantPlaces,
  runAiSession,
  type AiLedger,
  type AssistantDeps,
} from "@rikuy/core";
import { describe, expect, it } from "vitest";

import {
  createSupabasePublishedContentReader,
  createSupabasePublishedEventReader,
} from "./content";
import { env, stackAvailable } from "./integration/local-stack";

const NORTE = "5eed1000-0000-4000-8000-000000000001";

const ledger: AiLedger = {
  begin: async () => ({ requestId: "plan-test", outcome: "reserved" }),
  finish: async () => undefined,
};

const readers = {
  destinations: createSupabasePublishedContentReader({
    url: env.url,
    publishableKey: env.publishableKey,
  }),
  events: createSupabasePublishedEventReader({ url: env.url, publishableKey: env.publishableKey }),
};

describe.runIf(stackAvailable)("plans with the portal's published data", () => {
  it("reads the hours of published destinations only", async () => {
    const hours = await readers.destinations.openingHours(NORTE);
    expect([...hours]).toEqual([["mirador-del-valle", { mode: "always", note: "Al aire libre" }]]);
    expect(
      (await readers.destinations.openingHours("5eed1000-0000-4000-8000-000000000002")).size,
    ).toBe(0);
  });

  it("never recommends the event that already ended, even as the nearest place", async () => {
    const provider = createSimulatedAiProvider();
    const tenant = {
      tenantId: NORTE,
      timezone: "America/La_Paz",
      hasTours: false,
      presentation: defaultPresentation({ displayName: "Municipio Demo Norte" }),
    };
    const deps: AssistantDeps = {
      session: (input, work) => runAiSession(input, { ledger, provider }, work),
      search: async () => [],
      page: async () => null,
      places: (id) => loadAssistantPlaces(id, readers),
      tourContext: async () => null,
      now: () => new Date(),
    };
    for (const intent of ["nearby", "today", "route"] as const) {
      const { reply, trace } = await askAssistant(
        tenant,
        {
          question: "¿Qué hago?",
          intent,
          distances: {
            "event:festival-de-invierno": 0,
            "destination:plaza-principal": 100,
            "destination:mirador-del-valle": 900,
            // A draft is never a published place.
            "destination:feria-de-los-domingos": 50,
          },
        },
        null,
        deps,
      );
      expect(reply.status, intent).toBe("answered");
      const stops = trace?.plan?.stops ?? [];
      expect(stops, intent).not.toContain("event:festival-de-invierno");
      expect(stops, intent).not.toContain("destination:feria-de-los-domingos");
      if (intent === "nearby") {
        expect(stops).toEqual(["destination:plaza-principal", "destination:mirador-del-valle"]);
      }
      if (reply.status === "answered" && reply.plan && reply.plan.stops.length > 0) {
        // The square has no published hours; the viewpoint is always open.
        const plaza = reply.plan.stops.find((stop) => stop.href === "/destinos/plaza-principal");
        if (plaza) expect(plaza.note, intent).toBe("Sin horario publicado: confírmalo antes de ir");
      }
    }
  });
});
