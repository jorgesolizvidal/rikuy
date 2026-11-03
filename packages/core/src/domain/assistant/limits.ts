/** What the browser may send with a question (ADR-038); the server cuts anything longer. */
export const ASSISTANT_LIMITS = {
  question: 500,
  /** Messages of the conversation sent back with each question. */
  historyMessages: 6,
  historyMessage: 600,
  /** How long the conversation is kept on the device (ADR-022). */
  keepMs: 24 * 60 * 60 * 1000,
  /** Passages the model reads, and how much of each. */
  passages: 4,
  passageCharacters: 1200,
  /** Plans (ADR-039): distances the phone may send, rounded to this many meters. */
  distances: 60,
  distanceStep: 100,
} as const;
