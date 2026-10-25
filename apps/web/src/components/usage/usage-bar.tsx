import type { UsageMeter } from "@rikuy/core";

import { formatAmount, formatShare, RESOURCE_LABELS } from "./usage-format";

/** One quota as an accessible meter: used, in progress and what is left. */
export function UsageBar({
  meter,
  label,
}: {
  readonly meter: UsageMeter;
  readonly label?: string;
}) {
  const used = formatAmount(meter.resource, meter.consumed);
  const limit = formatAmount(meter.resource, meter.limit);
  const text = `${used} de ${limit} (${formatShare(meter.share)})`;
  const consumed = meter.limit > 0 ? Math.min(100, (meter.consumed / meter.limit) * 100) : 100;
  const reserved =
    meter.limit > 0 ? Math.min(100 - consumed, (meter.reserved / meter.limit) * 100) : 0;
  return (
    <div className="usage-bar" data-level={meter.level}>
      <div
        className="usage-track"
        role="meter"
        aria-label={label ?? RESOURCE_LABELS[meter.resource]}
        aria-valuemin={0}
        aria-valuemax={meter.limit}
        aria-valuenow={Math.min(meter.consumed + meter.reserved, meter.limit)}
        aria-valuetext={text}
      >
        <span className="usage-fill" style={{ width: `${consumed}%` }} />
        <span className="usage-reserved" style={{ width: `${reserved}%` }} />
      </div>
      <p className="usage-figures">
        <strong>{used}</strong> de {limit}
        <span className="cell-detail">{formatShare(meter.share)} usado</span>
        {meter.reserved > 0 ? (
          <span className="cell-detail">
            Incluye {formatAmount(meter.resource, meter.reserved)} reservados para lo que está en
            proceso
          </span>
        ) : null}
      </p>
    </div>
  );
}
