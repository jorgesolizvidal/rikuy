import { describe, expect, it } from "vitest";

import { isSmallTalk, maskPersonalData, questionWords, unansweredText } from "./unanswered";

describe("maskPersonalData", () => {
  it("masks emails and links", () => {
    expect(maskPersonalData("Escriban a ana.perez+viajes@correo.com.bo por favor")).toBe(
      "Escriban a [correo] por favor",
    );
    expect(maskPersonalData("Vi esto en https://ejemplo.com/x?id=9 y www.algo.bo")).toBe(
      "Vi esto en [enlace] y [enlace]",
    );
  });

  it("tells a Bolivian mobile or an international number from other long numbers", () => {
    expect(maskPersonalData("mi celular es 71234567")).toBe("mi celular es [teléfono]");
    expect(maskPersonalData("llámame al 712-34567")).toBe("llámame al [teléfono]");
    expect(maskPersonalData("desde Argentina +54 (11) 4567-8901")).toBe(
      "desde Argentina [teléfono]",
    );
    expect(maskPersonalData("+591 4 4123456 es el fijo")).toBe("[teléfono] es el fijo");
    expect(maskPersonalData("mi CI 1234567 LP")).toBe("mi CI [número] LP");
    expect(maskPersonalData("tarjeta 4111 1111 1111 1111")).toBe("tarjeta [número]");
  });

  it("leaves dates, years, prices and hours as they are", () => {
    for (const text of [
      "¿Hay feria el 15-11-2026?",
      "¿Qué hubo en 2025-2026?",
      "¿Cuesta 1.500 Bs?",
      "¿Abre de 9:00 a 17:00?",
      "¿Hay buses a las 6?",
      "Somos 12 personas",
    ]) {
      expect(maskPersonalData(text)).toBe(text);
    }
  });
});

describe("unansweredText", () => {
  it("drops a greeting in front, joins the lines and masks", () => {
    expect(unansweredText("Hola, ¿hay wifi?")).toBe("¿hay wifi?");
    expect(unansweredText("Buenos días!\n¿Dónde   cambio dólares?")).toBe("¿Dónde cambio dólares?");
    expect(unansweredText("Hello, is there an ATM? I'm at +1 555 123 4567")).toBe(
      "is there an ATM? I'm at [teléfono]",
    );
  });

  it("keeps nothing for small talk or an empty question", () => {
    for (const text of [
      "Hola",
      "¡Muchas gracias!",
      "ok",
      "Thank you",
      "buenas noches",
      "  ",
      "¿?",
    ]) {
      expect(unansweredText(text)).toBeNull();
    }
    expect(isSmallTalk("hola, ¿hay wifi?")).toBe(false);
  });

  it("cuts a long question at 500 characters", () => {
    expect(unansweredText("palabra ".repeat(100))?.length).toBeLessThanOrEqual(500);
  });

  it("splits words as the database groups them", () => {
    expect(questionWords("¿HAY WiFí, señor?")).toEqual(["hay", "wifi", "senor"]);
  });
});
