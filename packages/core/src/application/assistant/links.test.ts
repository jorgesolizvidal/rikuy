import { describe, expect, it } from "vitest";

import type { AssistantReply } from "./ask";
import {
  contentKeyOfPath,
  linkFor,
  parseAssistantChannel,
  retargetCards,
  retargetReply,
  type AssistantLinkPolicy,
} from "./links";

const web = new Map([
  ["destination:museo", "https://www.muni.gob.bo/turismo/museo"],
  ["service:cajero", "https://www.muni.gob.bo/servicios#cajero"],
]);

const policy = (portal: boolean, channel: AssistantLinkPolicy["channel"]): AssistantLinkPolicy => ({
  portal,
  channel,
  webLinks: web,
});

const answered: AssistantReply = {
  status: "answered",
  lang: "es",
  speaker: "Chaski",
  blocks: [{ type: "paragraph", text: "El museo abre a las 9." }],
  sources: [
    { title: "Museo", label: "Destino", href: "/destinos/museo", page: null, ended: false },
    { title: "Plaza", label: "Destino", href: "/destinos/plaza", page: null, ended: false },
    { title: "Tour", label: "Tour 360°", href: "/destinos/museo/tour", page: null, ended: false },
    { title: "Libro", label: "Documento", href: null, page: "pág. 3", ended: false },
  ],
  abstained: false,
  links: [{ label: "Destinos", href: "/destinos" }],
  contact: null,
  plan: {
    intent: "route",
    title: "Ruta sugerida",
    start: null,
    stops: [
      {
        position: 1,
        kind: "destination",
        title: "Museo",
        href: "/destinos/museo",
        time: null,
        distance: null,
        note: null,
      },
    ],
    mapHref: "/mapa?ruta=destination:museo",
    needsLocation: false,
  },
};

describe("where the assistant's answers link (ADR-071)", () => {
  it("knows which published item a portal path is about", () => {
    expect(contentKeyOfPath("/destinos/museo")).toBe("destination:museo");
    expect(contentKeyOfPath("/agenda/carnaval")).toBe("event:carnaval");
    expect(contentKeyOfPath("/avisos#corte-de-ruta")).toBe("notice:corte-de-ruta");
    expect(contentKeyOfPath("/servicios#cajero")).toBe("service:cajero");
    expect(contentKeyOfPath("/memoria#la-helada")).toBe("story:la-helada");
    expect(contentKeyOfPath("/destinos/museo/tour?escena=x")).toBeNull();
    expect(contentKeyOfPath("/destinos")).toBeNull();
  });

  it("reads the channel the browser names, the portal's button by default", () => {
    expect(parseAssistantChannel("insertar")).toBe("embed");
    expect(parseAssistantChannel("qr")).toBe("qr");
    expect(parseAssistantChannel("cualquiera")).toBe("portal");
    expect(parseAssistantChannel(null)).toBe("portal");
  });

  it("on the portal keeps the portal's pages, even when there is a page on the website", () => {
    expect(linkFor("/destinos/museo", policy(true, "portal"))).toBeUndefined();
    expect(linkFor("/destinos/museo", policy(true, "qr"))).toBeUndefined();
    expect(retargetReply(answered, policy(true, "portal"))).toEqual(answered);
  });

  it("inside the municipality's website links to its own pages, the rest to the portal", () => {
    const reply = retargetReply(answered, policy(true, "embed"));
    if (reply.status !== "answered") throw new Error("answered");
    expect(reply.sources.map((source) => source.link)).toEqual([
      "https://www.muni.gob.bo/turismo/museo",
      undefined,
      undefined,
      undefined,
    ]);
    expect(reply.sources[0]?.href).toBe("/destinos/museo");
    expect(reply.plan?.stops[0]?.link).toBe("https://www.muni.gob.bo/turismo/museo");
    expect(reply.plan?.mapHref).toBe("/mapa?ruta=destination:museo");
    expect(reply.links).toEqual(answered.links);
  });

  it("without a portal links only to the website, offers no section and no map", () => {
    for (const channel of ["embed", "qr", "portal"] as const) {
      const reply = retargetReply(answered, policy(false, channel));
      if (reply.status !== "answered") throw new Error("answered");
      expect(reply.sources.map((source) => source.link)).toEqual([
        "https://www.muni.gob.bo/turismo/museo",
        null,
        null,
        undefined,
      ]);
      expect(reply.links).toEqual([]);
      expect(reply.plan?.mapHref).toBeNull();
    }
    expect(linkFor("/servicios#cajero", policy(false, "qr"))).toBe(
      "https://www.muni.gob.bo/servicios#cajero",
    );
  });

  it("without a portal a notice offers no section either", () => {
    const notice: AssistantReply = {
      status: "notice",
      lang: "es",
      notice: {
        speaker: "Chaski",
        message: "No estoy disponible.",
        retry: "minutes",
        links: [{ label: "Destinos", href: "/destinos" }],
        contact: null,
      },
    };
    const reply = retargetReply(notice, policy(false, "embed"));
    expect(reply.status === "notice" && reply.notice.links).toEqual([]);
    expect(retargetReply(notice, policy(true, "embed"))).toEqual(notice);
  });

  it("gives the cards the same links as the sources", () => {
    const cards = [
      { href: "/destinos/museo", title: "Museo" },
      { href: "/destinos/plaza", title: "Plaza" },
    ];
    expect(retargetCards(cards, policy(false, "qr"))).toEqual([
      { href: "/destinos/museo", title: "Museo", link: "https://www.muni.gob.bo/turismo/museo" },
      { href: "/destinos/plaza", title: "Plaza", link: null },
    ]);
    expect(retargetCards(cards, policy(true, "portal"))).toEqual(cards);
  });
});
