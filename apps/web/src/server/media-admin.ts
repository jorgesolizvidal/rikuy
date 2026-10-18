import "server-only";

import { parseServerEnv } from "@rikuy/config/env";
import type { ImageProcessor, MediaAdmin } from "@rikuy/core";
import { createSharpImageProcessor, createSupabaseMediaAdmin } from "@rikuy/db";

let admin: MediaAdmin | undefined;
let processor: ImageProcessor | undefined;

/**
 * Writer of image derivatives and of the public media bucket (secret key, CONTRIBUTING
 * §1.3). Only the logo Server Actions import it, after the use case authorized the caller.
 */
export function mediaAdmin(): MediaAdmin {
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
