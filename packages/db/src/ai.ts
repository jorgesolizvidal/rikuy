/**
 * @rikuy/db/ai — the AI gateway's adapters (ADR-036): its own PostgreSQL connection as the
 * role rikuy_ai and the model provider. Imported only by the web app's AI gateway module.
 */
export { createPostgresAiLedger } from "./ai-ledger";
export type { PostgresAiLedger, PostgresAiLedgerOptions } from "./ai-ledger";
export { createGroqProvider, groqFailureKind, GROQ_CHAT_COMPLETIONS } from "./groq-provider";
export type { GroqProviderOptions } from "./groq-provider";
