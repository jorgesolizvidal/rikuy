import { z } from "zod";

/**
 * Rich text as an allow-listed AST (no HTML, CSS or scripts). Mirrors
 * `private.is_valid_rich_text` in the database.
 *
 *   block  = paragraph | heading (level 2–3) | list (ordered or not)
 *   inline = text (optionally bold/italic) | link (https only, text children)
 */

export const RICH_TEXT_LIMITS = {
  blocks: 200,
  inlines: 200,
  listItems: 100,
  textRun: 5000,
  href: 2000,
  linkChildren: 20,
  /** Visible characters in the whole document. */
  characters: 20_000,
} as const;

export const RICH_TEXT_MARKS = ["bold", "italic"] as const;
export type RichTextMark = (typeof RICH_TEXT_MARKS)[number];

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
const HTTPS_URL = /^https:\/\/[^/@?#\s]+([/?#]\S*)?$/u;

const textRunSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1).max(RICH_TEXT_LIMITS.textRun).regex(NO_CONTROL_CHARACTERS),
  marks: z
    .array(z.enum(RICH_TEXT_MARKS))
    .min(1)
    .max(2)
    .refine((marks) => new Set(marks).size === marks.length)
    .optional(),
});

export const httpsLinkSchema = z
  .string()
  .min(9)
  .max(RICH_TEXT_LIMITS.href)
  .regex(NO_CONTROL_CHARACTERS)
  .regex(HTTPS_URL)
  .refine((value) => value === value.trim());

const linkSchema = z.strictObject({
  type: z.literal("link"),
  href: httpsLinkSchema,
  children: z.array(textRunSchema).min(1).max(RICH_TEXT_LIMITS.linkChildren),
});

const inlinesSchema = z
  .array(z.discriminatedUnion("type", [textRunSchema, linkSchema]))
  .min(1)
  .max(RICH_TEXT_LIMITS.inlines);

const blockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("paragraph"), children: inlinesSchema }),
  z.strictObject({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3)]),
    children: inlinesSchema,
  }),
  z.strictObject({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(inlinesSchema).min(1).max(RICH_TEXT_LIMITS.listItems),
  }),
]);

const blocksSchema = z.array(blockSchema).max(RICH_TEXT_LIMITS.blocks);

export type RichText = z.infer<typeof blocksSchema>;
export type RichTextBlock = RichText[number];
export type RichTextInlines = Extract<RichTextBlock, { type: "paragraph" }>["children"];
export type RichTextInline = RichTextInlines[number];
export type RichTextRun = Extract<RichTextInline, { type: "text" }>;

function inlineText(inlines: readonly RichTextInline[]): string {
  return inlines
    .map((inline) =>
      inline.type === "text" ? inline.text : inline.children.map((run) => run.text).join(""),
    )
    .join("");
}

/** Plain text of each block, e.g. for search, summaries or the assistant's context. */
export function richTextToPlainText(blocks: readonly RichTextBlock[]): string {
  return blocks
    .map((block) =>
      block.type === "list"
        ? block.items.map((item) => `• ${inlineText(item)}`).join("\n")
        : inlineText(block.children),
    )
    .join("\n\n");
}

/** Number of visible characters. */
export function richTextLength(blocks: readonly RichTextBlock[]): number {
  return richTextToPlainText(blocks).length;
}

export const richTextSchema = blocksSchema.refine(
  (blocks) => richTextLength(blocks) <= RICH_TEXT_LIMITS.characters,
  { message: "too_long" },
);
