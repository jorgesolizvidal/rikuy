/**
 * @rikuy/core/assistant-client — what the portal's assistant panel needs in the browser,
 * without schemas (see geo.ts): the page it is asked from, the limits and the reply's shape.
 */
export * from "./domain/assistant/limits";
export * from "./domain/assistant/page";
export * from "./domain/plan/intent";
export type { AnswerBlock } from "./domain/assistant/answer";
export type { AssistantLanguage } from "./domain/assistant/language";
export type { AssistantLink, AssistantReply } from "./application/assistant/ask";
export type { AssistantPlan, AssistantPlanStop } from "./application/assistant/plan";
export type { PlanIntent } from "./domain/plan/engine";
export type { AiNotice } from "./application/ai/notices";
export type { PublicCitation } from "./contracts/knowledge";
