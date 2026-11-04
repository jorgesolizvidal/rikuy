/**
 * A word diff for the proposal's review (ADR-042): what stays, what goes, what comes. Plain
 * and deterministic (longest common subsequence over words and spaces); long texts fall
 * back to «everything changed» rather than spending time on a huge table.
 */

export type DiffPart =
  | { readonly kind: "same"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "added"; readonly text: string };

/** Words and the spaces between them, so joining the parts gives the text back. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

/** Above this many cells (words × words) the diff gives up on detail. */
const MAX_CELLS = 400_000;

function push(parts: DiffPart[], kind: DiffPart["kind"], text: string) {
  const last = parts.at(-1);
  if (last && last.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
  else parts.push({ kind, text });
}

export function wordDiff(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    const parts: DiffPart[] = [];
    if (before) parts.push({ kind: "removed", text: before });
    if (after) parts.push({ kind: "added", text: after });
    return parts;
  }
  // lengths[i][j]: common subsequence of a[i..] and b[j..]
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(parts, "same", a[i] ?? "");
      i += 1;
      j += 1;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      push(parts, "removed", a[i] ?? "");
      i += 1;
    } else {
      push(parts, "added", b[j] ?? "");
      j += 1;
    }
  }
  for (; i < a.length; i += 1) push(parts, "removed", a[i] ?? "");
  for (; j < b.length; j += 1) push(parts, "added", b[j] ?? "");
  return parts;
}
