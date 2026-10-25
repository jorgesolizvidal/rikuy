import "server-only";

import { parseServerEnv } from "@rikuy/config/env";
import type { ImageProcessor, MediaAdmin, OriginalRemover } from "@rikuy/core";
import { createSharpImageProcessor, createSupabaseMediaAdmin } from "@rikuy/db";

let admin: (MediaAdmin & OriginalRemover) | undefined;
let processor: ImageProcessor | undefined;

/**
 * Writer of image derivatives and of the public media bucket (secret key, CONTRIBUTING
 * §1.3). The image Server Actions use it after the use case authorized the caller, and the
 * job runner removes originals with it, only for an exact path the ledger handed a job.
 */
export function mediaAdmin(): MediaAdmin & OriginalRemover {
  if (admin) return admin;
  const env = parseServerEnv();
  admin = createSupabaseMediaAdmin({
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    secretKey: env.SUPABASE_SECRET_KEY,
  });
  return admin;
}

export function imageProcessor(): ImageProcessor {
  processor ??= createSharpImageProcessor();
  return processor;
}
