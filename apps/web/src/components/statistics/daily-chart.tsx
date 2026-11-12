import { formatShortDate, type VisitStatisticsDay } from "@rikuy/core";

import { formatCount } from "./format";

const WIDTH = 640;
const HEIGHT = 160;
const LABEL_SPACE = 22;

/**
 * Page views per day: one series, one hue, bars from the baseline with a 2px gap; the exact
 * numbers are in the table below it (and in each bar's tooltip).
 */
export function DailyChart({ series }: { readonly series: readonly VisitStatisticsDay[] }) {
  const max = Math.max(1, ...series.map((day) => day.views));
  const slot = WIDTH / Math.max(1, series.length);
  const bar = Math.max(2, Math.min(24, slot - 2));
  const plot = HEIGHT - LABEL_SPACE;
  const peak = series.reduce<VisitStatisticsDay | null>(
    (best, day) => (best === null || day.views > best.views ? day : best),
    null,
  );
  const total = series.reduce((sum, day) => sum + day.views, 0);
  const first = series[0];
  const last = series.at(-1);

  return (
    <figure className="stats-chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={
          peak && peak.views > 0
            ? `Vistas por día: ${formatCount(total)} en total; el día con más fue el ${formatShortDate(peak.day)}, con ${formatCount(peak.views)}.`
            : "Vistas por día: ninguna en este período."
        }
        preserveAspectRatio="none"
      >
        <line x1="0" x2={WIDTH} y1={plot} y2={plot} className="stats-chart-axis" />
        {series.map((day, index) => {
          const height = day.views === 0 ? 0 : Math.max(2, (day.views / max) * (plot - 8));
          const x = index * slot + (slot - bar) / 2;
          return (
            <g key={day.day}>
              <title>{`${formatShortDate(day.day)}: ${formatCount(day.views)} vistas, ${formatCount(day.visitors)} visitantes`}</title>
              {/* A taller invisible target than the bar, for the tooltip. */}
              <rect x={index * slot} y="0" width={slot} height={plot} className="stats-chart-hit" />
              {height > 0 ? (
                <path
                  className="stats-chart-bar"
                  d={`M${x},${plot} v${-(height - Math.min(4, height / 2))} q0,${-Math.min(4, height / 2)} ${Math.min(4, bar / 2)},${-Math.min(4, height / 2)} h${bar - 2 * Math.min(4, bar / 2)} q${Math.min(4, bar / 2)},0 ${Math.min(4, bar / 2)},${Math.min(4, height / 2)} v${height - Math.min(4, height / 2)} z`}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="stats-chart-ends" aria-hidden="true">
        <span>{first ? formatShortDate(first.day) : ""}</span>
        <span>Máx. {formatCount(max === 1 && !peak?.views ? 0 : max)} vistas en un día</span>
        <span>{last ? formatShortDate(last.day) : ""}</span>
      </figcaption>
    </figure>
  );
}
