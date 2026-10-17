/**
 * Decorative topographic contour lines behind the portal hero. The "terrain" is derived
 * from the tenant id, so every municipality gets its own map-like pattern without any
 * asset. Pure SVG rendered on the server: no JavaScript, no network request.
 */

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    return ((state ^= state >>> 16) >>> 0) / 4294967296;
  };
}

function contourPaths(seed: string): string[] {
  const random = seededRandom(seed);
  const waves = Array.from({ length: 3 }, () => ({
    frequency: 2 + Math.floor(random() * 4),
    phase: random() * Math.PI * 2,
    amplitude: 0.05 + random() * 0.08,
  }));
  const center = { x: 300 + random() * 120, y: 220 + random() * 80 };

  return Array.from({ length: 9 }, (_, ring) => {
    const radius = 34 + ring * 30;
    const points = Array.from({ length: 72 }, (_, step) => {
      const angle = (step / 72) * Math.PI * 2;
      const wobble = waves.reduce(
        (sum, wave) =>
          sum + wave.amplitude * Math.sin(wave.frequency * angle + wave.phase + ring * 0.35),
        1,
      );
      const r = radius * wobble;
      return `${(center.x + Math.cos(angle) * r * 1.35).toFixed(1)},${(center.y + Math.sin(angle) * r).toFixed(1)}`;
    });
    return `M${points.join("L")}Z`;
  });
}

export function Contour({ seed }: { readonly seed: string }) {
  return (
    <svg
      className="portal-contour"
      viewBox="0 0 720 480"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {contourPaths(seed).map((d, ring) => (
        <path key={ring} d={d} className={ring % 4 === 3 ? "index-line" : undefined} />
      ))}
    </svg>
  );
}
