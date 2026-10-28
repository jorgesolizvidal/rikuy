import { operationsSnapshotSchema, type OperationsRepository } from "@rikuy/core";

import type { SessionClient } from "./session-client";

/**
 * The operations snapshot (migration 20261031000000) with the operator's own session: the
 * database checks the second factor; anyone else gets nothing.
 */
export function createOperationsRepository(client: SessionClient): OperationsRepository {
  return {
    async snapshot() {
      const { data, error } = await client.rpc("platform_operations");
      if (error) {
        if (error.code === "42501") return null;
        throw new Error(`Reading the operations snapshot failed (${error.code ?? "unknown"})`);
      }
      return operationsSnapshotSchema.parse(data);
    },
  };
}
