import type { PublishedPresentationReader, PublishedPresentationRecord } from "./ports";

/**
 * Sealed configurations are immutable, so a found record can be kept for the life of the
 * instance (bounded by `maxEntries`). Misses and errors are not cached: a miss means the
 * caller holds a stale configuration id, which resolves itself on the next lookup.
 */
export function createCachedPresentationReader(
  inner: PublishedPresentationReader,
  options: { readonly maxEntries?: number } = {},
): PublishedPresentationReader {
  const maxEntries = options.maxEntries ?? 500;
  const entries = new Map<string, PublishedPresentationRecord>();
  const inFlight = new Map<string, Promise<PublishedPresentationRecord | null>>();

  return {
    async findPublished(configId) {
      const cached = entries.get(configId);
      if (cached !== undefined) return cached;

      const pending = inFlight.get(configId);
      if (pending !== undefined) return pending;

      const lookup = inner
        .findPublished(configId)
        .then((record) => {
          if (record !== null) {
            if (entries.size >= maxEntries) {
              const oldest = entries.keys().next();
              if (!oldest.done) entries.delete(oldest.value);
            }
            entries.set(configId, record);
          }
          return record;
        })
        .finally(() => inFlight.delete(configId));
      inFlight.set(configId, lookup);
      return lookup;
    },
  };
}
