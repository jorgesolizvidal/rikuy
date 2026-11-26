import type { PlanIntent, PlanVisit, VisitLength } from "./engine";

/**
 * Which questions are plans (ADR-039). The panel's buttons send the intent explicitly; a
 * typed question is recognized only by clear phrases, so «¿qué hay en la plaza?» stays a
 * question for the published texts.
 */

const fold = (text: string) =>
  text
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const PATTERNS: readonly (readonly [PlanIntent, RegExp])[] = [
  [
    "route",
    /\b(ruta sugerida|una ruta|que ruta|ruta para (hoy|caminar|recorrer|visitar|conocer)|armame una ruta|itinerario|suggested route|a route|walking route|route for (today|me)|itinerary)\b/u,
  ],
  [
    "today",
    /\b(plan para hoy|plan de hoy|un plan (para|de) hoy|que (puedo |podemos )?(hacer|visitar|ver) hoy|que hago hoy|que hacer hoy|hoy que (puedo |podemos )?(hacer|visitar|ver)|plan for today|today s plan|what (can|should) (i|we) do today|what to do today|things to do today)\b/u,
  ],
  [
    "nearby",
    /\b(que (hay|puedo (ver|visitar|hacer)) cerca|cerca de (mi|aqui|donde estoy)|lo mas cercano|mas cerca de mi|lugares cercanos|what s near|whats near|what is near|near me|nearby|close to me|closest)\b/u,
  ],
];

export function detectPlanIntent(question: string): PlanIntent | null {
  const text = fold(question);
  for (const [intent, pattern] of PATTERNS) if (pattern.test(text)) return intent;
  return null;
}

const NUMBERS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** The longest time a plan can be asked for in hours (a longer one is the full day). */
export const VISIT_HOURS = { min: 1, max: 10 } as const;

const HOURS_ES =
  /\b(?:tengo|tenemos|tienes|dispongo de|disponemos de|plan de|plan para|solo|solamente|unas|por|durante)\s+(?:solo\s+|solamente\s+|unas\s+)?(\d{1,2}|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+horas?(\s+y\s+media)?\b/u;
const HOURS_EN =
  /\b(?:i have|we have|i ve got|we ve got|got|only|for|a|plan of|plan for)\s+(?:only\s+|just\s+)?(\d{1,2}|an|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:hours?|hrs?)(\s+and\s+a\s+half)?\b/u;
const COUPLE = /\b(un par de horas|a couple of hours)\b/u;
const HALF_DAY = /\b(medio dia|media jornada|media manana|media tarde|half day|half a day)\b/u;
const FULL_DAY =
  /\b(todo el dia|dia completo|dia entero|el dia entero|jornada completa|full day|whole day|all day|entire day)\b/u;
const KIDS =
  /\b(con (?:los |las |mis |nuestros |nuestras |unos |unas |)(?:ninos|ninas|nenes|nenas|hijos|hijas|chicos|chicas|guaguas|wawas|pequenos|pequenas|peques|criaturas|chiquitos)|en familia|with (?:the |my |our |)(?:kids|children|family|little ones|toddlers)|family friendly|kid friendly)\b/u;
const PLAN_WORDS =
  /\b(plan|planes|que (?:puedo|podemos|hago|hacemos|hacer|visitar|ver|recomiendas)|paseo|pasear|recorrido|recorrer|salir|actividades|itinerario|what (?:to do|can (?:i|we) do|should (?:i|we) do)|things to do|where (?:to go|can (?:i|we) go)|ideas)\b/u;

/**
 * The kind of visit a typed question asks for (ADR-072): «tengo 3 horas», «medio día»,
 * «todo el día», «con mis hijos» (with a plan word: «¿qué hacemos con los chicos?»). Null
 * when it asks for none; «¿el museo es apto para niños?» stays a question for the texts.
 */
export function detectPlanVisit(question: string): PlanVisit | null {
  const text = fold(question);
  let length: VisitLength | null = null;
  if (FULL_DAY.test(text)) length = { kind: "full_day" };
  else if (HALF_DAY.test(text)) length = { kind: "hours", minutes: 240 };
  else if (COUPLE.test(text)) length = { kind: "hours", minutes: 120 };
  else {
    const match = HOURS_ES.exec(text) ?? HOURS_EN.exec(text);
    const word = match?.[1];
    const hours = word === undefined ? Number.NaN : (NUMBERS[word] ?? Number.parseInt(word, 10));
    if (Number.isInteger(hours) && hours >= VISIT_HOURS.min) {
      const minutes = hours * 60 + (match?.[2] ? 30 : 0);
      length = hours > VISIT_HOURS.max ? { kind: "full_day" } : { kind: "hours", minutes };
    }
  }
  const kids = KIDS.test(text);
  if (length === null && !(kids && PLAN_WORDS.test(text))) return null;
  return { length, kids };
}
