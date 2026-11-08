import { BASE_GOLD, type GoldCase } from "./gold";
import { EXTRA_GOLD } from "./gold-v2";

/**
 * The whole assistant gold, v2 (ADR-045): 83 development (G01–G83), 40 held-out (H01–H40)
 * and 40 security (S01–S40) cases: 123 of quality, at least the audit's 120.
 */
export const ASSISTANT_GOLD: readonly GoldCase[] = [...BASE_GOLD, ...EXTRA_GOLD];
