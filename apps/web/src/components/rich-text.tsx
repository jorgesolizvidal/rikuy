import type { RichTextBlock, RichTextInline, RichTextRun } from "@rikuy/core";
import type { ReactNode } from "react";

/**
 * Renders the allow-listed rich text AST as React elements. There is no HTML string and
 * no `dangerouslySetInnerHTML`: text is always text, links are https only (validated).
 */

function Run({ run }: { readonly run: RichTextRun }) {
  let node: ReactNode = run.text;
  if (run.marks?.includes("italic")) node = <em>{node}</em>;
  if (run.marks?.includes("bold")) node = <strong>{node}</strong>;
  return node;
}

function Inlines({ items }: { readonly items: readonly RichTextInline[] }) {
  return items.map((item, index) =>
    item.type === "text" ? (
      <Run key={index} run={item} />
    ) : (
      <a key={index} href={item.href} rel="noopener noreferrer nofollow">
        {item.children.map((run, runIndex) => (
          <Run key={runIndex} run={run} />
        ))}
      </a>
    ),
  );
}

export function RichTextView({
  blocks,
  headingOffset = 0,
}: {
  readonly blocks: readonly RichTextBlock[];
  /** Shifts heading levels (e.g. 1 inside a preview that already has an h2). */
  readonly headingOffset?: 0 | 1;
}) {
  return blocks.map((block, index) => {
    if (block.type === "paragraph") {
      return (
        <p key={index}>
          <Inlines items={block.children} />
        </p>
      );
    }
    if (block.type === "heading") {
      const Heading =
        block.level + headingOffset === 2 ? "h2" : block.level + headingOffset === 3 ? "h3" : "h4";
      return (
        <Heading key={index}>
          <Inlines items={block.children} />
        </Heading>
      );
    }
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>
            <Inlines items={item} />
          </li>
        ))}
      </List>
    );
  });
}
