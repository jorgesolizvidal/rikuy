import type { ServiceCategory } from "../../contracts/service";

/**
 * The names of the platform's service categories (ADR-069): the database keeps only the key.
 * `name` labels one service («Dónde comer»); `section` heads its group on `/servicios`; `words`
 * go into what the assistant reads, so «¿hay un cajero?» finds the card.
 */
export const SERVICE_CATEGORY_INFO: Readonly<
  Record<
    ServiceCategory,
    { readonly name: string; readonly section: string; readonly words: string }
  >
> = {
  food: {
    name: "Comida",
    section: "Dónde comer",
    words: "Dónde comer: restaurante, comida, almuerzo, cena.",
  },
  lodging: {
    name: "Alojamiento",
    section: "Dónde dormir",
    words: "Dónde dormir: alojamiento, hotel, hostal, hospedaje.",
  },
  cash: {
    name: "Cajero o banco",
    section: "Cajeros y bancos",
    words: "Cajero automático o banco: sacar dinero, efectivo.",
  },
  transport: {
    name: "Transporte",
    section: "Transporte",
    words: "Transporte: taxi, bus, minibús, trufi, terminal.",
  },
  fuel: {
    name: "Gasolina",
    section: "Gasolina",
    words: "Gasolina: surtidor, estación de servicio, combustible.",
  },
  health: {
    name: "Salud",
    section: "Salud",
    words: "Salud: centro de salud, farmacia, emergencias, médico.",
  },
  tourist_info: {
    name: "Información turística",
    section: "Información turística",
    words: "Información turística: oficina de turismo, guías.",
  },
  other: {
    name: "Otro servicio",
    section: "Otros servicios",
    words: "Servicio.",
  },
};

/** The digits of a number for a `tel:` link (a leading «+» stays). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/gu, "")}`;
}

/** A wa.me link: the international number, digits only. */
export function whatsappHref(whatsapp: string): string {
  return `https://wa.me/${whatsapp.replace(/\D/gu, "")}`;
}
