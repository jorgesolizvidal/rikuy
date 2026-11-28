import type { AnswerBlock } from "../../domain/assistant/answer";
import type { HelpDeskContact } from "../../domain/assistant/handoff";
import { handoffMessage, helpDeskName, whatsappMessageHref } from "../../domain/assistant/handoff";
import type { AssistantLanguage } from "../../domain/assistant/language";
import { localClock } from "../../domain/plan/clock";
import { describeOpenState, openStateAt } from "../../domain/plan/hours";
import type { AssistantReply } from "../assistant/ask";
import type { AssistantPlan, AssistantPlanStop } from "../assistant/plan";

/**
 * An answer of the assistant as a WhatsApp message (ADR-075): plain text with WhatsApp's own
 * marks (*bold*), every link absolute and written out, the sources at the end. WhatsApp shows
 * a message of up to 4.096 characters; a longer one is cut at a line.
 */

export const WHATSAPP_TEXT_LIMIT = 4096;

export interface WhatsAppFormat {
  /** «https://rikuy-ucurena.vercel.app»: the portal's address; null without a public portal. */
  readonly origin: string | null;
  readonly siteName: string;
  /** «Atención al visitante» (ADR-073), for «quiero hablar con una persona». */
  readonly desk: HelpDeskContact | null;
  /** The question just asked, written in the message for the help desk. */
  readonly question: string | null;
  readonly timezone: string;
  readonly now: Date;
}

const WORDS = {
  es: {
    sources: "Fuentes",
    seeAlso: "También puedes ver",
    route: "Ver la ruta en el mapa",
    route2: "Verlos en el mapa",
    trip: "Recorrido",
    walk: "a pie",
    ends: "Termina",
    kids: "Apto para niños",
    shareLocation:
      "Comparte tu ubicación (📎 → Ubicación) y te digo qué hay cerca, con sus distancias.",
    phone: "Teléfono",
    email: "Correo",
    whatsapp: "WhatsApp",
    person: (desk: string) => `Para hablar con una persona, escribe o llama a ${desk}:`,
    noPerson:
      "El municipio todavía no publicó un contacto para hablar con una persona. Puedes seguir preguntándome a mí.",
    page: (page: string) => page,
  },
  en: {
    sources: "Sources",
    seeAlso: "You can also see",
    route: "See the route on the map",
    route2: "See them on the map",
    trip: "Route",
    walk: "walking",
    ends: "Ends",
    kids: "Suitable for children",
    shareLocation:
      "Share your location (📎 → Location) and I'll tell you what is nearby, with distances.",
    phone: "Phone",
    email: "Email",
    whatsapp: "WhatsApp",
    person: (desk: string) => `To talk to a person, write to or call ${desk}:`,
    noPerson:
      "The municipality has not published a contact to talk to a person yet. You can keep asking me.",
    page: (page: string) =>
      page.replace(/^págs?\.\s*/u, (match) => (match.startsWith("págs") ? "pp. " : "p. ")),
  },
} as const;

/** Where something leads: its own link (null: nowhere), else the portal's page. */
export function absoluteLink(
  href: string | null,
  link: string | null | undefined,
  origin: string | null,
): string | null {
  if (link === null) return null;
  if (typeof link === "string") return link;
  if (href === null || href === "") return null;
  if (/^https?:\/\//u.test(href)) return href;
  return origin && href.startsWith("/") ? `${origin}${href}` : null;
}

/** WhatsApp reads *…* as bold: a stray asterisk in the text would make bold by mistake. */
function plain(text: string): string {
  return text.replace(/[*_~`]/gu, "").trim();
}

function blocksText(blocks: readonly AnswerBlock[]): string {
  return blocks
    .map((block) =>
      block.type === "paragraph"
        ? plain(block.text)
        : block.items.map((item) => `• ${plain(item)}`).join("\n"),
    )
    .filter((text) => text !== "")
    .join("\n\n");
}

function stopLines(
  stop: AssistantPlanStop,
  origin: string | null,
  lang: AssistantLanguage,
): string {
  const words = WORDS[lang];
  const facts = [stop.time, stop.distance].filter((fact): fact is string => Boolean(fact));
  const lines = [
    `${stop.position}. *${plain(stop.title)}*${facts.length ? ` — ${facts.join(" · ")}` : ""}`,
  ];
  if (stop.kids) lines.push(`   ${words.kids}`);
  if (stop.note) lines.push(`   ${plain(stop.note)}`);
  const link = absoluteLink(stop.href, stop.link, origin);
  if (link) lines.push(`   ${link}`);
  return lines.join("\n");
}

function planText(plan: AssistantPlan, origin: string | null, lang: AssistantLanguage): string {
  const words = WORDS[lang];
  const parts = [`*${plain(plan.title)}*`];
  if (plan.start) parts.push(plain(plan.start));
  if (plan.stops.length > 0) {
    parts.push(plan.stops.map((stop) => stopLines(stop, origin, lang)).join("\n"));
  }
  const summary = plan.summary;
  if (summary) {
    const facts = [
      summary.distance ? `${words.trip}: ${summary.distance}` : null,
      summary.walk ? `~${summary.walk} ${words.walk}` : null,
      summary.endsAt ? `${words.ends}: ${summary.endsAt}` : null,
    ].filter((fact): fact is string => fact !== null);
    if (facts.length > 0) parts.push(facts.join(" · "));
  }
  const map = absoluteLink(plan.mapHref, undefined, origin);
  if (map) parts.push(`${plan.intent === "nearby" ? words.route2 : words.route}: ${map}`);
  if (plan.needsLocation) parts.push(words.shareLocation);
  return parts.join("\n\n");
}

function contactLines(
  contact: { readonly phone?: string; readonly email?: string } | null,
  lang: AssistantLanguage,
): string[] {
  const words = WORDS[lang];
  return [
    ...(contact?.phone ? [`${words.phone}: ${contact.phone}`] : []),
    ...(contact?.email ? [`${words.email}: ${contact.email}`] : []),
  ];
}

function linkLines(
  links: readonly { readonly label: string; readonly href: string }[],
  origin: string | null,
): string[] {
  return links.flatMap((item) => {
    const link = absoluteLink(item.href, undefined, origin);
    return link ? [`• ${plain(item.label)}: ${link}`] : [];
  });
}

function handoffText(format: WhatsAppFormat, lang: AssistantLanguage): string {
  const words = WORDS[lang];
  const desk = format.desk;
  if (desk === null) return words.noPerson;
  const lines = [words.person(helpDeskName(desk, lang))];
  if (desk.whatsapp) {
    const message = handoffMessage(format.siteName, format.question, lang);
    lines.push(`• ${words.whatsapp}: ${whatsappMessageHref(desk.whatsapp, message)}`);
  }
  if (desk.phone) lines.push(`• ${words.phone}: ${desk.phone}`);
  if (desk.email) lines.push(`• ${words.email}: ${desk.email}`);
  const open = describeOpenState(
    openStateAt(desk.hours, localClock(format.now, format.timezone)),
    lang,
  );
  if (open) lines.push(open);
  return lines.join("\n");
}

/** Cut at a line so the message fits, never in the middle of a link. */
export function fitWhatsAppText(text: string): string {
  if (text.length <= WHATSAPP_TEXT_LIMIT) return text;
  const cut = text.slice(0, WHATSAPP_TEXT_LIMIT - 2);
  const line = cut.lastIndexOf("\n");
  return `${(line > WHATSAPP_TEXT_LIMIT / 2 ? cut.slice(0, line) : cut).trimEnd()}\n…`;
}

export function whatsappReplyText(reply: AssistantReply, format: WhatsAppFormat): string | null {
  if (reply.status === "invalid") return null;
  const lang = reply.lang;
  const words = WORDS[lang];
  if (reply.status === "handoff") return fitWhatsAppText(handoffText(format, lang));
  if (reply.status === "notice") {
    const { notice } = reply;
    const links = linkLines(notice.links, format.origin);
    const parts = [
      plain(notice.message),
      ...(links.length > 0 ? [`${words.seeAlso}:\n${links.join("\n")}`] : []),
      ...(contactLines(notice.contact, lang).length > 0
        ? [contactLines(notice.contact, lang).join("\n")]
        : []),
    ];
    return fitWhatsAppText(parts.join("\n\n"));
  }

  const parts: string[] = [];
  const body = blocksText(reply.blocks);
  if (body) parts.push(body);
  if (reply.plan) parts.push(planText(reply.plan, format.origin, lang));
  if (reply.abstained) {
    const links = linkLines(reply.links, format.origin);
    if (links.length > 0) parts.push(`${words.seeAlso}:\n${links.join("\n")}`);
    const contact = contactLines(reply.contact, lang);
    if (contact.length > 0) parts.push(contact.join("\n"));
  }
  const sources = reply.sources.map((source) => {
    const page = source.page ? ` (${words.page(source.page)})` : "";
    const link = absoluteLink(source.href, source.link, format.origin);
    return `• ${plain(source.label)} «${plain(source.title)}»${page}${link ? `: ${link}` : ""}`;
  });
  if (sources.length > 0) parts.push(`${words.sources}:\n${sources.join("\n")}`);
  return fitWhatsAppText(parts.join("\n\n"));
}

/**
 * What the conversation keeps of an answer (the last six messages, 24 hours): its words only,
 * as the portal keeps them, never its links.
 */
export function whatsappMemoryText(reply: AssistantReply): string {
  if (reply.status === "answered") {
    const body = blocksText(reply.blocks);
    const plan = reply.plan
      ? `${plain(reply.plan.title)}: ${reply.plan.stops.map((stop) => plain(stop.title)).join(", ")}`
      : "";
    return [body, plan].filter((text) => text !== "").join(" ");
  }
  if (reply.status === "notice") return plain(reply.notice.message);
  return "";
}
