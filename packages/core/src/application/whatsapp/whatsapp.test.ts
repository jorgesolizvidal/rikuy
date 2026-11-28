import { describe, expect, it, vi } from "vitest";

import { parseWhatsAppWebhook } from "../../domain/whatsapp/webhook";
import type { AssistantReply, AssistantResult } from "../assistant/ask";
import type { AssistantPlaces } from "../assistant/plan";
import {
  answerWhatsApp,
  distancesFrom,
  WHATSAPP_MESSAGES,
  type WhatsAppAssistant,
  type WhatsAppBegin,
  type WhatsAppDeps,
} from "./conversation";
import {
  absoluteLink,
  fitWhatsAppText,
  WHATSAPP_TEXT_LIMIT,
  whatsappMemoryText,
  whatsappReplyText,
  type WhatsAppFormat,
} from "./format";
import {
  addWhatsAppNumber,
  parseDisplayPhone,
  removeWhatsAppNumber,
  whatsappChatHref,
  type PlatformWhatsAppRepository,
} from "./numbers";

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
}

const TENANT = "5eed1000-0000-4000-8000-000000000002";
const KEY = "a".repeat(64);

function delivery(messages: unknown[], phoneNumberId = "1234567890") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ wa_id: "59167680091", profile: { name: "Visitante" } }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("what Meta relays to the webhook (ADR-075)", () => {
  it("reads texts, voice notes and locations, and the number they were sent to", () => {
    expect(
      parseWhatsAppWebhook(
        delivery([
          { from: "59167680091", id: "wamid.1", type: "text", text: { body: "Hola" } },
          { from: "59167680091", id: "wamid.2", type: "audio", audio: { id: "media1" } },
          {
            from: "59167680091",
            id: "wamid.3",
            type: "location",
            location: { latitude: -17.5, longitude: -65.9 },
          },
          { from: "59167680091", id: "wamid.4", type: "image", image: { id: "x" } },
        ]),
      ),
    ).toEqual([
      expect.objectContaining({
        phoneNumberId: "1234567890",
        messageId: "wamid.1",
        kind: "text",
        text: "Hola",
      }),
      expect.objectContaining({ messageId: "wamid.2", kind: "audio", mediaId: "media1" }),
      expect.objectContaining({ kind: "location", location: { lat: -17.5, lng: -65.9 } }),
      expect.objectContaining({ kind: "other", text: null }),
    ]);
  });

  it("leaves out statuses, other fields and anything of an unexpected shape", () => {
    const statuses = delivery([]);
    must(must(statuses.entry[0]).changes[0]).value.messages = undefined as never;
    expect(parseWhatsAppWebhook(statuses)).toEqual([]);
    expect(parseWhatsAppWebhook({ ...delivery([]), object: "page" })).toEqual([]);
    expect(parseWhatsAppWebhook(null)).toEqual([]);
    expect(parseWhatsAppWebhook(delivery([{ from: "../x", id: "1", type: "text" }]))).toEqual([]);
    expect(parseWhatsAppWebhook(delivery([], "abc"))).toEqual([]);
    const other = delivery([{ from: "59167680091", id: "w", type: "text", text: { body: "x" } }]);
    must(must(other.entry[0]).changes[0]).field = "account_update";
    expect(parseWhatsAppWebhook(other)).toEqual([]);
  });

  it("answers at most 20 messages of one delivery", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      from: "59167680091",
      id: `wamid.${index}`,
      type: "text",
      text: { body: "Hola" },
    }));
    expect(parseWhatsAppWebhook(delivery(many))).toHaveLength(20);
  });
});

const format: WhatsAppFormat = {
  origin: "https://ucurena.example.test",
  siteName: "Explora Ucureña",
  desk: null,
  question: "¿Hay cajero?",
  timezone: "America/La_Paz",
  now: new Date("2026-11-28T15:00:00Z"),
};

const answered: AssistantReply = {
  status: "answered",
  lang: "es",
  speaker: "Chaski",
  blocks: [
    { type: "paragraph", text: "El *museo* abre a las 9." },
    { type: "list", items: ["Lunes a viernes", "Sábados"] },
  ],
  sources: [
    { title: "Museo", label: "Destino", href: "/destinos/museo", page: null, ended: false },
    { title: "Libro", label: "Documento", href: null, page: "págs. 61–68", ended: false },
    {
      title: "Plaza",
      label: "Destino",
      href: "/destinos/plaza",
      link: "https://web.example.test/plaza",
      page: null,
      ended: false,
    },
  ],
  abstained: false,
  links: [],
  contact: null,
};

describe("the answer as a WhatsApp message (ADR-075)", () => {
  it("writes the text and the sources with absolute links at the end", () => {
    expect(whatsappReplyText(answered, format)).toBe(
      [
        "El museo abre a las 9.",
        "• Lunes a viernes\n• Sábados",
        "Fuentes:\n• Destino «Museo»: https://ucurena.example.test/destinos/museo\n• Documento «Libro» (págs. 61–68)\n• Destino «Plaza»: https://web.example.test/plaza",
      ].join("\n\n"),
    );
  });

  it("without a public portal, only the municipality's website leads somewhere", () => {
    expect(absoluteLink("/destinos/museo", undefined, null)).toBeNull();
    expect(absoluteLink("/destinos/museo", null, "https://x.test")).toBeNull();
    expect(absoluteLink("/destinos/museo", "https://web.test/m", null)).toBe("https://web.test/m");
    const text = must(whatsappReplyText(answered, { ...format, origin: null }));
    expect(text).toContain("• Destino «Museo»\n");
    expect(text).toContain("https://web.example.test/plaza");
  });

  it("writes a plan with its stops, the map and the share-your-location hint", () => {
    const text = must(
      whatsappReplyText(
        {
          ...answered,
          blocks: [],
          sources: [],
          plan: {
            intent: "nearby",
            title: "Qué hay cerca",
            start: null,
            stops: [
              {
                position: 1,
                kind: "destination",
                title: "Museo",
                href: "/destinos/museo",
                time: null,
                distance: "300 m",
                note: null,
              },
            ],
            mapHref: "/mapa?ruta=destination:museo",
            needsLocation: true,
          },
        },
        format,
      ),
    );
    expect(text).toContain("*Qué hay cerca*");
    expect(text).toContain("1. *Museo* — 300 m\n   https://ucurena.example.test/destinos/museo");
    expect(text).toContain(
      "Verlos en el mapa: https://ucurena.example.test/mapa?ruta=destination:museo",
    );
    expect(text).toContain("Comparte tu ubicación");
  });

  it("writes a notice with its links and contact, and nothing for an invalid request", () => {
    const text = whatsappReplyText(
      {
        status: "notice",
        lang: "es",
        notice: {
          speaker: "Chaski",
          message: "Por hoy ya respondí todo.",
          retry: "tomorrow",
          links: [{ label: "Destinos", href: "/destinos" }],
          contact: { phone: "+591 4 000000" },
        },
      },
      format,
    );
    expect(text).toBe(
      "Por hoy ya respondí todo.\n\nTambién puedes ver:\n• Destinos: https://ucurena.example.test/destinos\n\nTeléfono: +591 4 000000",
    );
    expect(whatsappReplyText({ status: "invalid" }, format)).toBeNull();
  });

  it("hands off to a person with the help desk's WhatsApp and the question written", () => {
    const text = must(
      whatsappReplyText(
        { status: "handoff", lang: "es", speaker: "Chaski" },
        {
          ...format,
          desk: {
            name: "Oficina de turismo",
            whatsapp: "+59170000000",
            phone: null,
            email: "t@x.test",
            hours: null,
          },
        },
      ),
    );
    expect(text).toContain("Oficina de turismo");
    expect(text).toMatch(/WhatsApp: https:\/\/wa\.me\/59170000000\?text=.*cajero/u);
    expect(text).toContain("Correo: t@x.test");
    expect(
      whatsappReplyText({ status: "handoff", lang: "es", speaker: "Chaski" }, format),
    ).toContain("todavía no publicó un contacto");
  });

  it("fits WhatsApp's limit, cut at a line", () => {
    const long = Array.from(
      { length: 500 },
      (_, index) => `línea ${index} https://x.test/${index}`,
    ).join("\n");
    const fitted = fitWhatsAppText(long);
    expect(fitted.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT);
    expect(fitted.endsWith("\n…")).toBe(true);
    expect(fitted.split("\n").at(-2)).toMatch(/^línea \d+ https:\/\/x\.test\/\d+$/u);
  });

  it("keeps the words of an answer in the conversation, never its links", () => {
    expect(whatsappMemoryText(answered)).toBe(
      "El museo abre a las 9.\n\n• Lunes a viernes\n• Sábados",
    );
    expect(whatsappMemoryText({ status: "invalid" })).toBe("");
  });
});

const places: AssistantPlaces = {
  destinations: [
    { slug: "lejos", title: "Lejos", location: { lat: -17.6, lng: -65.9 } },
    { slug: "cerca", title: "Cerca", location: { lat: -17.5001, lng: -65.9 } },
    { slug: "sin", title: "Sin ubicación", location: null },
  ],
  events: [{ slug: "feria", title: "Feria", location: { lat: -17.51, lng: -65.9 } }],
  services: [{ slug: "cajero", title: "Cajero", location: { lat: -17.502, lng: -65.9 } }],
} as unknown as AssistantPlaces;

describe("a shared location (ADR-075)", () => {
  it("becomes distances to what is published, the nearest first", () => {
    const distances = distancesFrom(places, { lat: -17.5, lng: -65.9 });
    expect(Object.keys(distances)).toEqual([
      "destination:cerca",
      "service:cajero",
      "event:feria",
      "destination:lejos",
    ]);
    expect(distances["destination:cerca"]).toBeLessThan(20);
  });
});

function result(reply: AssistantReply, extra: Partial<AssistantResult> = {}): AssistantResult {
  return { reply, trace: null, ...extra } as AssistantResult;
}

function harness(begin: WhatsAppBegin, assistant: Partial<WhatsAppAssistant> | null = {}) {
  const sent: string[] = [];
  const remembered: string[][] = [];
  const asked: unknown[] = [];
  const full: WhatsAppAssistant | null =
    assistant === null
      ? null
      : {
          ask: async (request) => {
            asked.push(request);
            return result(answered, {
              turn: { requestId: "r", kind: "answered", pageKind: "home", cited: [] },
            } as never);
          },
          transcribe: async () => ({ status: "transcribed", text: "¿Dónde está el museo?" }),
          places: async () => places,
          format: async (value) => whatsappReplyText(value.reply, format),
          recordTurn: vi.fn(async () => undefined),
          recordUnanswered: vi.fn(async () => undefined),
          ...assistant,
        };
  const deps: WhatsAppDeps = {
    begin: async () => begin,
    open: async () => full,
    send: async (_id, _to, text) => {
      sent.push(text);
    },
    remember: async (_tenant, _key, question, answer) => {
      remembered.push([question, answer]);
    },
  };
  return { deps, sent, remembered, asked, assistant: full };
}

const begun: WhatsAppBegin = {
  status: "new",
  tenantId: TENANT,
  host: "ucurena.example.test",
  contactKey: KEY,
  history: [{ role: "user", text: "Hola" }],
};
const text = must(
  parseWhatsAppWebhook(
    delivery([
      { from: "59167680091", id: "wamid.1", type: "text", text: { body: "  ¿Qué  es el museo? " } },
    ]),
  )[0],
);
const audio = must(
  parseWhatsAppWebhook(
    delivery([{ from: "59167680091", id: "wamid.2", type: "audio", audio: { id: "media1" } }]),
  )[0],
);
const location = must(
  parseWhatsAppWebhook(
    delivery([
      {
        from: "59167680091",
        id: "wamid.3",
        type: "location",
        location: { latitude: -17.5, longitude: -65.9 },
      },
    ]),
  )[0],
);

describe("one message to a municipality's number (ADR-075)", () => {
  it("is answered by its assistant, with the conversation, and then remembered and counted", async () => {
    const run = harness(begun);
    expect(await answerWhatsApp(text, run.deps)).toBe("answered");
    expect(run.asked).toEqual([
      {
        history: begun.status === "new" ? begun.history : [],
        page: { kind: "home" },
        question: "¿Qué es el museo?",
      },
    ]);
    expect(run.sent[0]).toContain("Fuentes:");
    expect(run.remembered).toEqual([["¿Qué es el museo?", whatsappMemoryText(answered)]]);
    expect(must(run.assistant).recordTurn).toHaveBeenCalledOnce();
    expect(must(run.assistant).recordUnanswered).toHaveBeenCalledOnce();
  });

  it("answers nothing twice, for an unknown number or a municipality that is not online", async () => {
    for (const status of ["duplicate", "unknown_number", "unavailable", "capped"] as const) {
      const run = harness({ status });
      expect(await answerWhatsApp(text, run.deps)).toBe(status);
      expect(run.sent).toEqual([]);
    }
  });

  it("says so when the municipality does not have the assistant", async () => {
    const run = harness(begun, null);
    expect(await answerWhatsApp(text, run.deps)).toBe("no_assistant");
    expect(run.sent).toEqual([WHATSAPP_MESSAGES.noAssistant]);
  });

  it("passes a voice note to text and says what it understood", async () => {
    const run = harness(begun);
    expect(await answerWhatsApp(audio, run.deps)).toBe("answered");
    expect(must(run.sent[0]).startsWith("Entendí: «¿Dónde está el museo?»\n\n")).toBe(true);
    expect(run.asked[0]).toMatchObject({ question: "¿Dónde está el museo?" });
  });

  it("without voice, or when the voice note fails, says so and asks nothing", async () => {
    const noVoice = harness(begun, { transcribe: null });
    expect(await answerWhatsApp(audio, noVoice.deps)).toBe("no_voice");
    expect(noVoice.sent).toEqual([WHATSAPP_MESSAGES.noVoice]);
    const failed = harness(begun, {
      transcribe: async () => ({ status: "notice", message: "Por hoy no puedo escuchar más." }),
    });
    expect(await answerWhatsApp(audio, failed.deps)).toBe("voice_failed");
    expect(failed.sent).toEqual(["Por hoy no puedo escuchar más."]);
    expect(failed.asked).toEqual([]);
  });

  it("turns a shared location into «¿Qué hay cerca?» with distances, never the position", async () => {
    const run = harness(begun);
    expect(await answerWhatsApp(location, run.deps)).toBe("answered");
    const request = run.asked[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      intent: "nearby",
      question: WHATSAPP_MESSAGES.locationQuestion,
    });
    expect(JSON.stringify(request)).not.toContain("-17.5,");
    expect(JSON.stringify(request)).not.toContain("-65.9");
    expect(Object.keys(request.distances as object)[0]).toBe("destination:cerca");
  });

  it("explains what it understands for anything else", async () => {
    const run = harness(begun);
    const image = must(
      parseWhatsAppWebhook(
        delivery([{ from: "59167680091", id: "w", type: "image", image: { id: "x" } }]),
      )[0],
    );
    expect(await answerWhatsApp(image, run.deps)).toBe("unsupported");
    expect(run.sent).toEqual([WHATSAPP_MESSAGES.unsupported]);
  });

  it("does not fail the visitor when remembering or counting fails", async () => {
    const run = harness(begun, { recordTurn: async () => Promise.reject(new Error("down")) });
    run.deps.remember = async () => Promise.reject(new Error("down"));
    expect(await answerWhatsApp(text, run.deps)).toBe("answered");
    expect(run.sent).toHaveLength(1);
  });
});

describe("the WhatsApp numbers of a municipality (ADR-075)", () => {
  const repository = (): PlatformWhatsAppRepository & { calls: unknown[][] } => {
    const calls: unknown[][] = [];
    return {
      calls,
      list: async () => [],
      add: async (...args) => {
        calls.push(args);
        return { status: "updated", numbers: [] };
      },
      remove: async (...args) => {
        calls.push(args);
        return { status: "updated", numbers: [] };
      },
    };
  };

  it("reads the number for visitors", () => {
    expect(parseDisplayPhone(" +591 (676) 80-091 ")).toBe("+591 676 80 091");
    expect(parseDisplayPhone("")).toBeNull();
    expect(parseDisplayPhone(undefined)).toBeNull();
    expect(parseDisplayPhone("67680091")).toBe(false);
    expect(parseDisplayPhone(591)).toBe(false);
    expect(whatsappChatHref("+591 676 80091")).toBe("https://wa.me/59167680091");
  });

  it("checks Meta's id and the number before the database", async () => {
    const repo = repository();
    expect(await addWhatsAppNumber(repo, TENANT, "abc", null)).toEqual({ status: "invalid" });
    expect(await addWhatsAppNumber(repo, TENANT, "1234567890", "67680091")).toEqual({
      status: "display",
    });
    expect(await addWhatsAppNumber(repo, "", "1234567890", null)).toEqual({ status: "invalid" });
    expect(await removeWhatsAppNumber(repo, TENANT, 5)).toEqual({ status: "invalid" });
    expect(repo.calls).toEqual([]);
    await addWhatsAppNumber(repo, TENANT, " 1234567890 ", "+591 67680091");
    await removeWhatsAppNumber(repo, TENANT, "1234567890");
    expect(repo.calls).toEqual([
      [TENANT, "1234567890", "+591 67680091"],
      [TENANT, "1234567890"],
    ]);
  });
});
