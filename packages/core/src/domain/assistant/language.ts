/**
 * The language of a visitor's question (ADR-038): the assistant answers in English when
 * asked in English and in Spanish otherwise. Deterministic and tiny on purpose: it decides
 * the answer's language and the notices', not what the question means.
 */
export type AssistantLanguage = "es" | "en";

const ENGLISH = new Set(
  (
    "the is are was were what what's where where's when how which who whom why can could do does " +
    "did there to of and in for you your i i'm my me we our near nearby open opening visit about " +
    "tell this that these those with time today tomorrow tonight any best should would from at " +
    "on hi hello hey thanks thank please much many it's an it be have has get go see things " +
    "place places event events town city square museum market river trail hours price cost"
  ).split(" "),
);

const SPANISH = new Set(
  (
    "el la los las lo es son era fue qué que dónde donde cuándo cuando cómo como cuál cual quién " +
    "hay de del y en para por un una unos unas me mi mis puedo puede se al con hoy mañana hola " +
    "gracias está esta este estos estas le su sus tiene hacer ver lugar lugares evento eventos " +
    "plaza museo mercado río sendero horario precio cuesta abre cerca muy más también pero si"
  ).split(" "),
);

export function detectLanguage(text: string): AssistantLanguage {
  const lower = text.toLocaleLowerCase("es");
  let spanish = /[ñáéíóú¿¡]/u.test(lower) ? 2 : 0;
  let english = 0;
  for (const word of lower.match(/[a-záéíóúñü']+/gu) ?? []) {
    if (ENGLISH.has(word)) english += 1;
    if (SPANISH.has(word)) spanish += 1;
  }
  return english > spanish ? "en" : "es";
}
