import type { Measure } from "@rikuy/core";

import { changeLabel } from "./format";

/** «▲ 12 %» next to a number, with its long form for screen readers. */
export function Change({ measure }: { readonly measure: Measure }) {
  const change = changeLabel(measure);
  if (!change) return null;
  return (
    <span
      className="stats-change"
      data-trend={
        measure.change === null
          ? "flat"
          : measure.change > 0
            ? "up"
            : measure.change < 0
              ? "down"
              : "flat"
      }
    >
      <span aria-hidden="true">{change.short}</span>
      <span className="visually-hidden">{change.long}</span>
    </span>
  );
}
