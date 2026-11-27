import { describe, expect, it } from "vitest";

import {
  detectHandoff,
  emailMessageHref,
  handoffMessage,
  helpDeskName,
  helpDeskOf,
  phoneHref,
  whatsappMessageHref,
} from "./handoff";

describe("helpDeskOf", () => {
  it("joins «Atención al visitante» with the portal's phone and email", () => {
    expect(
      helpDeskOf({
        contact: { phone: " 4 4441234 ", email: "turismo@example.test" },
        helpDesk: {
          name: "Oficina de turismo",
          whatsapp: "+591 71234567",
          hours: { mode: "always", note: "" },
        },
      }),
    ).toEqual({
      name: "Oficina de turismo",
      whatsapp: "+591 71234567",
      phone: "4 4441234",
      email: "turismo@example.test",
      hours: { mode: "always", note: "" },
    });
  });

  it("without a help desk, the municipality's team with the phone and the email", () => {
    const desk = helpDeskOf({ contact: { email: "turismo@example.test" } });
    expect(desk).toMatchObject({ name: null, whatsapp: null, phone: null, hours: null });
    expect(desk && helpDeskName(desk, "es")).toBe("el equipo del municipio");
    expect(desk && helpDeskName(desk, "en")).toBe("the municipality's team");
  });

  it("is nobody when there is no way to reach a person", () => {
    expect(helpDeskOf({ contact: {}, helpDesk: { name: "Oficina" } })).toBeNull();
    expect(helpDeskOf({ contact: { phone: "  " } })).toBeNull();
  });
});

describe("the message", () => {
  it("is written with the visitor's question, in their language", () => {
    expect(handoffMessage("Explora Demo", "  ¿Abre   el museo?  ", "es")).toBe(
      "Hola, vi el portal de Explora Demo. Mi consulta: ¿Abre el museo?",
    );
    expect(handoffMessage("Explora Demo", null, "es")).toBe(
      "Hola, vi el portal de Explora Demo y tengo una consulta.",
    );
    expect(handoffMessage("Explora Demo", "Is it open?", "en")).toBe(
      "Hello, I saw the Explora Demo portal. My question: Is it open?",
    );
  });

  it("goes in a wa.me link, a phone link and an email", () => {
    expect(whatsappMessageHref("+591 (712) 34-567", "Hola & chau")).toBe(
      "https://wa.me/59171234567?text=Hola%20%26%20chau",
    );
    expect(phoneHref("+591 4 444-1234")).toBe("tel:+59144441234");
    expect(emailMessageHref("t@example.test", "Explora", "Hola", "es")).toBe(
      "mailto:t@example.test?subject=Consulta%20desde%20el%20portal%20de%20Explora&body=Hola",
    );
  });
});

describe("detectHandoff", () => {
  it.each([
    "Quiero hablar con una persona",
    "¿Puedo hablar con alguien?",
    "pásame con un humano",
    "Necesito comunicarme con la oficina de turismo",
    "¿Con quién puedo hablar?",
    "quiero atención humana",
    "Can I talk to a real person?",
    "I want to speak with someone",
    "human agent please",
  ])("«%s» asks for a person", (question) => {
    expect(detectHandoff(question)).toBe(true);
  });

  it.each([
    "¿Qué personas famosas nacieron aquí?",
    "¿A qué hora abre el museo?",
    "¿Hay atención los domingos?",
    "¿Dónde puedo hablar con un guía del museo?",
    "Who are the famous people from here?",
    `Quiero hablar con una persona ${"sobre la historia del lugar ".repeat(8)}`,
  ])("«%s» is a question", (question) => {
    expect(detectHandoff(question)).toBe(false);
  });
});
