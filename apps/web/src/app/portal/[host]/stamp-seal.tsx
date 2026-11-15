/**
 * The passport's stamp drawn as a round seal (C3 · Paso 5, ADR-064): the place's name around
 * the rim and, inside, the date it was stamped. Decorative: the page says the same in words
 * next to it (the seal is `aria-hidden`). Inked with the municipality's color when stamped,
 * dashed and grey while missing, in the accent when it is the next suggested stop. Plain markup
 * with no hooks: it renders on the server and in the browser alike.
 */

export type SealState = "stamped" | "missing" | "next";

/** The rim holds ~30 characters at this size; longer names are cut with «…». */
const RIM_LENGTH = 30;

function rimText(title: string): string {
  const upper = title.toLocaleUpperCase("es");
  return upper.length > RIM_LENGTH ? `${upper.slice(0, RIM_LENGTH - 1)}…` : upper;
}

export function StampSeal({
  id,
  title,
  state,
  date = null,
  located = false,
  size = 112,
  animate = false,
  rim = true,
}: {
  /** Unique on the page: names the circle the text runs along. */
  readonly id: string;
  readonly title: string;
  readonly state: SealState;
  /** «13 NOV» once stamped. */
  readonly date?: string | null;
  /** A small pin when the stamp was taken at the place. */
  readonly located?: boolean;
  readonly size?: number;
  /** The «stamping» motion right after collecting it (none with reduced motion). */
  readonly animate?: boolean;
  /** The name around the rim; off where the seal is too small to read it (C3 · Paso 8). */
  readonly rim?: boolean;
}) {
  const path = `${id}-rim`;
  return (
    <svg
      className="stamp-seal"
      data-state={state}
      data-animate={animate ? "true" : undefined}
      viewBox="0 0 120 120"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* From the bottom, clockwise: the top of the rim is at 50%, so the name is centered there. */}
        <path id={path} d="M60 105a45 45 0 1 1 0-90a45 45 0 1 1 0 90" />
      </defs>
      <circle className="stamp-seal-outer" cx="60" cy="60" r="56" />
      <circle className="stamp-seal-inner" cx="60" cy="60" r="36" />
      {rim ? (
        <text className="stamp-seal-rim">
          <textPath href={`#${path}`} startOffset="50%" textAnchor="middle">
            {rimText(title)}
          </textPath>
        </text>
      ) : null}
      {state === "stamped" ? (
        <>
          <path className="stamp-seal-mark" d="m47 58 9 9 18-19" />
          {date ? (
            <text className="stamp-seal-date" x="60" y="84" textAnchor="middle">
              {date}
            </text>
          ) : null}
          {located ? (
            <path
              className="stamp-seal-pin"
              d="M60 31c-3.3 0-6 2.6-6 5.9 0 4.4 6 10.1 6 10.1s6-5.7 6-10.1c0-3.3-2.7-5.9-6-5.9Zm0 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4Z"
            />
          ) : null}
        </>
      ) : (
        <text className="stamp-seal-missing" x="60" y="66" textAnchor="middle">
          {state === "next" ? "→" : "?"}
        </text>
      )}
    </svg>
  );
}

/** The circuit's progress as a ring: «1/2» inside. Decorative: the words are next to it. */
export function ProgressRing({
  collected,
  total,
  size = 76,
}: {
  readonly collected: number;
  readonly total: number;
  readonly size?: number;
}) {
  const radius = 30;
  const length = 2 * Math.PI * radius;
  const share = total > 0 ? Math.min(1, collected / total) : 0;
  return (
    <svg
      className="progress-ring"
      data-complete={total > 0 && collected >= total ? "true" : undefined}
      viewBox="0 0 76 76"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <circle className="progress-ring-track" cx="38" cy="38" r={radius} />
      <circle
        className="progress-ring-value"
        cx="38"
        cy="38"
        r={radius}
        strokeDasharray={`${(share * length).toFixed(2)} ${length.toFixed(2)}`}
        transform="rotate(-90 38 38)"
      />
      <text className="progress-ring-text" x="38" y="43" textAnchor="middle">
        {collected}/{total}
      </text>
    </svg>
  );
}
