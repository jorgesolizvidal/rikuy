import "server-only";

import { operatorGate, type OperatorGate } from "@rikuy/core";
import { cache } from "react";

import { adminSession, requireAdminActor } from "./admin-session";

/** Signed-in actor plus where they stand in the operator gate (page use only). */
export const operatorContext = cache(async () => {
  const actor = await requireAdminActor();
  const session = await adminSession();
  const gate: OperatorGate = await operatorGate(session.platform, session.mfa);
  return { actor, gate, session };
});
