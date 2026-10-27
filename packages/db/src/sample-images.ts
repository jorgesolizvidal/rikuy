import type { SampleImageRenderer, SampleScene } from "@rikuy/core";
import sharp from "sharp";

/**
 * Illustrations of the demo's sample content (ADR-034): flat landscapes drawn as SVG and
 * rasterized with sharp, so no photo of any real place (and no binary) is ever involved.
 * Deterministic: the same scene and variant always give the same picture.
 */

const PHOTO = { width: 1600, height: 1067 } as const;
const PANORAMA = { width: 4096, height: 2048 } as const;

interface Palette {
  readonly skyTop: string;
  readonly skyHorizon: string;
  readonly sun: string;
  readonly far: string;
  readonly middle: string;
  readonly near: string;
  readonly groundTop: string;
  readonly groundBottom: string;
  readonly accent: readonly string[];
  readonly night?: boolean;
}

const DAY: Palette = {
  skyTop: "#5b9bd5",
  skyHorizon: "#cfe6f2",
  sun: "#fff4c2",
  far: "#9fb7c9",
  middle: "#6f9078",
  near: "#4d6b4f",
  groundTop: "#9aa86b",
  groundBottom: "#6f7d45",
  accent: ["#c8553d", "#f2a541", "#2e86ab", "#7a9e3b", "#a23e48"],
};
const GOLDEN: Palette = {
  skyTop: "#f08a4b",
  skyHorizon: "#fcd29f",
  sun: "#fff1d0",
  far: "#c89a8f",
  middle: "#8f6f62",
  near: "#5e4b45",
  groundTop: "#b5895a",
  groundBottom: "#7d5c3c",
  accent: ["#e4572e", "#ffc914", "#2e282a", "#76b041", "#17bebb"],
};
const DAWN: Palette = {
  skyTop: "#6c7fbf",
  skyHorizon: "#f6c1a6",
  sun: "#ffe9c7",
  far: "#a69bc0",
  middle: "#7d7a99",
  near: "#4f5470",
  groundTop: "#a69273",
  groundBottom: "#6b5d4b",
  accent: ["#f28482", "#f5cac3", "#84a59d", "#f6bd60", "#577590"],
};
const NIGHT: Palette = {
  skyTop: "#0b1533",
  skyHorizon: "#33416e",
  sun: "#f4f1de",
  far: "#2b3559",
  middle: "#222a47",
  near: "#161c33",
  groundTop: "#2c2f45",
  groundBottom: "#191b2b",
  accent: ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#f78c6b"],
  night: true,
};

const SCENE_PALETTE: Readonly<Record<SampleScene, readonly [Palette, Palette]>> = {
  plaza: [DAY, GOLDEN],
  mirador: [DAY, DAWN],
  museo: [DAY, GOLDEN],
  mercado: [DAY, DAWN],
  rio: [DAY, GOLDEN],
  feria: [DAY, GOLDEN],
  festival: [NIGHT, NIGHT],
  caminata: [DAWN, DAY],
};

/** What surrounds the viewer of a panorama: four views, each `[scene, plain]`. */
const PANORAMA_STRIPS: Readonly<Record<SampleScene, readonly (readonly [SampleScene, boolean])[]>> =
  {
    plaza: [
      ["plaza", false],
      ["mercado", false],
      ["plaza", true],
      ["museo", false],
    ],
    mirador: [
      ["mirador", false],
      ["rio", false],
      ["mirador", true],
      ["caminata", false],
    ],
    museo: [
      ["museo", false],
      ["plaza", true],
      ["plaza", false],
      ["rio", false],
    ],
    mercado: [
      ["mercado", false],
      ["plaza", true],
      ["feria", false],
      ["plaza", false],
    ],
    rio: [
      ["rio", false],
      ["mirador", true],
      ["caminata", false],
      ["plaza", true],
    ],
    feria: [
      ["feria", false],
      ["mercado", false],
      ["plaza", true],
      ["feria", false],
    ],
    festival: [
      ["festival", false],
      ["festival", false],
      ["festival", false],
      ["festival", false],
    ],
    caminata: [
      ["caminata", false],
      ["mirador", true],
      ["rio", false],
      ["caminata", false],
    ],
  };

/** Small seeded generator (mulberry32). */
function random(seed: string): () => number {
  let state = 0;
  for (const char of seed) state = (Math.imul(state ^ char.charCodeAt(0), 2_654_435_761) >>> 0) + 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const r1 = (value: number) => Math.round(value * 10) / 10;

/**
 * A ridge across the width: a sum of sines. With `periodic`, every frequency is a whole
 * number of turns over the width, so the left and right edges meet (panoramas).
 */
function ridge(options: {
  readonly width: number;
  readonly bottom: number;
  readonly base: number;
  readonly amplitude: number;
  readonly next: () => number;
  readonly periodic: boolean;
  readonly color: string;
  readonly opacity?: number;
}): string {
  const waves = [1, 2, 3, 5, 8].map((turns) => ({
    turns: options.periodic ? turns : turns + options.next() * 0.9,
    phase: options.next() * Math.PI * 2,
    weight: (0.35 + options.next() * 0.65) / turns,
  }));
  const total = waves.reduce((sum, wave) => sum + wave.weight, 0);
  const steps = 160;
  const points: string[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const x = (step / steps) * options.width;
    const y =
      options.base -
      (options.amplitude / total) *
        waves.reduce(
          (sum, wave) =>
            sum +
            wave.weight *
              (0.5 + 0.5 * Math.sin((2 * Math.PI * wave.turns * x) / options.width + wave.phase)),
          0,
        );
    points.push(`${r1(x)},${r1(y)}`);
  }
  return `<polygon points="0,${options.bottom} ${points.join(" ")} ${options.width},${options.bottom}" fill="${options.color}"${
    options.opacity ? ` opacity="${options.opacity}"` : ""
  }/>`;
}

function tree(x: number, ground: number, size: number, color: string): string {
  return (
    `<rect x="${r1(x - size * 0.06)}" y="${r1(ground - size * 0.5)}" width="${r1(size * 0.12)}" height="${r1(size * 0.5)}" fill="#4a3b2a"/>` +
    `<ellipse cx="${r1(x)}" cy="${r1(ground - size * 0.75)}" rx="${r1(size * 0.36)}" ry="${r1(size * 0.42)}" fill="${color}"/>`
  );
}

function building(x: number, ground: number, w: number, h: number, wall: string, roof: string) {
  const windows: string[] = [];
  const cols = Math.max(1, Math.floor(w / 46));
  const rows = Math.max(1, Math.floor((h - 40) / 60));
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      windows.push(
        `<rect x="${r1(x + 14 + c * ((w - 28) / cols))}" y="${r1(ground - h + 30 + r * 60)}" width="${r1(((w - 28) / cols) * 0.55)}" height="28" rx="3" fill="#3d4a5c" opacity="0.55"/>`,
      );
    }
  }
  return (
    `<rect x="${r1(x)}" y="${r1(ground - h)}" width="${r1(w)}" height="${r1(h)}" fill="${wall}"/>` +
    `<polygon points="${r1(x - 10)},${r1(ground - h)} ${r1(x + w / 2)},${r1(ground - h - 36)} ${r1(x + w + 10)},${r1(ground - h)}" fill="${roof}"/>` +
    windows.join("")
  );
}

function tower(x: number, ground: number, w: number, h: number, wall: string, roof: string) {
  return (
    `<rect x="${r1(x)}" y="${r1(ground - h)}" width="${r1(w)}" height="${r1(h)}" fill="${wall}"/>` +
    `<rect x="${r1(x + w * 0.3)}" y="${r1(ground - h + 30)}" width="${r1(w * 0.4)}" height="${r1(w * 0.5)}" rx="${r1(w * 0.2)}" fill="#3d4a5c" opacity="0.6"/>` +
    `<polygon points="${r1(x - 8)},${r1(ground - h)} ${r1(x + w / 2)},${r1(ground - h - w * 1.1)} ${r1(x + w + 8)},${r1(ground - h)}" fill="${roof}"/>`
  );
}

function stall(x: number, ground: number, w: number, colors: readonly string[]) {
  const stripes = 6;
  const awning: string[] = [];
  for (let i = 0; i < stripes; i += 1) {
    awning.push(
      `<rect x="${r1(x + (i * w) / stripes)}" y="${r1(ground - 150)}" width="${r1(w / stripes)}" height="40" fill="${i % 2 ? "#fbf5e6" : colors[i % colors.length]}"/>`,
    );
  }
  return (
    `<rect x="${r1(x + 6)}" y="${r1(ground - 110)}" width="${r1(w - 12)}" height="70" fill="#8c6a4f"/>` +
    `<rect x="${r1(x)}" y="${r1(ground - 40)}" width="${r1(w)}" height="40" fill="#6d513b"/>` +
    awning.join("") +
    `<circle cx="${r1(x + w * 0.3)}" cy="${r1(ground - 52)}" r="12" fill="${colors[1]}"/>` +
    `<circle cx="${r1(x + w * 0.55)}" cy="${r1(ground - 52)}" r="12" fill="${colors[3]}"/>`
  );
}

function bunting(x1: number, x2: number, y: number, sag: number, colors: readonly string[]) {
  const flags: string[] = [
    `<path d="M${r1(x1)},${r1(y)} Q${r1((x1 + x2) / 2)},${r1(y + sag)} ${r1(x2)},${r1(y)}" stroke="#3b3b3b" stroke-width="3" fill="none"/>`,
  ];
  const count = Math.max(4, Math.floor((x2 - x1) / 60));
  for (let i = 1; i < count; i += 1) {
    const t = i / count;
    const fx = x1 + (x2 - x1) * t;
    const fy = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * (y + sag) + t * t * y;
    flags.push(
      `<polygon points="${r1(fx - 18)},${r1(fy)} ${r1(fx + 18)},${r1(fy)} ${r1(fx)},${r1(fy + 40)}" fill="${colors[i % colors.length]}"/>`,
    );
  }
  return flags.join("");
}

function sky(width: number, horizon: number, palette: Palette, next: () => number, sunX: number) {
  const parts = [
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.skyTop}"/><stop offset="1" stop-color="${palette.skyHorizon}"/></linearGradient>` +
      `<radialGradient id="glow"><stop offset="0" stop-color="${palette.sun}" stop-opacity="0.9"/><stop offset="1" stop-color="${palette.sun}" stop-opacity="0"/></radialGradient>` +
      `<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${palette.groundTop}"/><stop offset="1" stop-color="${palette.groundBottom}"/></linearGradient></defs>`,
    `<rect width="${width}" height="${horizon + 2}" fill="url(#sky)"/>`,
  ];
  const sunY = horizon * (palette.night ? 0.3 : 0.45);
  parts.push(
    `<circle cx="${r1(sunX)}" cy="${r1(sunY)}" r="${r1(horizon * 0.35)}" fill="url(#glow)"/>`,
  );
  parts.push(
    `<circle cx="${r1(sunX)}" cy="${r1(sunY)}" r="${r1(horizon * 0.07)}" fill="${palette.sun}"/>`,
  );
  if (palette.night) {
    for (let i = 0; i < Math.round(width / 12); i += 1) {
      parts.push(
        `<circle cx="${r1(next() * width)}" cy="${r1(next() * horizon * 0.8)}" r="${r1(1 + next() * 2)}" fill="#ffffff" opacity="${r1(0.4 + next() * 0.6)}"/>`,
      );
    }
  } else {
    for (let i = 0; i < Math.max(3, Math.round(width / 400)); i += 1) {
      // Clouds never cross the edges (in a panorama, they meet each other).
      const cx = 320 + next() * (width - 640);
      const cy = horizon * (0.12 + next() * 0.35);
      const w = 90 + next() * 140;
      parts.push(
        `<g fill="#ffffff" opacity="0.75"><ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${r1(w)}" ry="${r1(w * 0.28)}"/><ellipse cx="${r1(cx - w * 0.35)}" cy="${r1(cy + 6)}" rx="${r1(w * 0.5)}" ry="${r1(w * 0.22)}"/><ellipse cx="${r1(cx + w * 0.25)}" cy="${r1(cy - w * 0.12)}" rx="${r1(w * 0.45)}" ry="${r1(w * 0.26)}"/></g>`,
      );
    }
  }
  return parts.join("");
}

/** The things of one scene along a strip [x0, x1] standing on `ground`. */
function foreground(
  scene: SampleScene,
  x0: number,
  x1: number,
  ground: number,
  scale: number,
  palette: Palette,
  next: () => number,
  plain = false,
): string {
  const span = x1 - x0;
  const parts: string[] = [];
  const at = (t: number) => x0 + span * t;
  const s = (value: number) => value * scale;
  switch (scene) {
    case "plaza": {
      const walls = ["#f1e3c8", "#e9cfa8", "#f4ede1", "#e3b98f"];
      for (let i = 0; i < 6; i += 1) {
        const w = s(150 + next() * 60);
        parts.push(
          building(
            at(0.02 + i * 0.165),
            ground,
            w,
            s(140 + next() * 70),
            walls[i % walls.length] ?? "#eee",
            "#a5543b",
          ),
        );
      }
      if (plain) {
        for (let i = 0; i < 5; i += 1)
          parts.push(tree(at(0.1 + i * 0.2), ground + s(40), s(120), palette.near));
        break;
      }
      parts.push(tower(at(0.47), ground, s(110), s(330), "#f4ede1", "#a5543b"));
      parts.push(
        `<ellipse cx="${r1(at(0.5))}" cy="${r1(ground + s(70))}" rx="${r1(s(150))}" ry="${r1(s(34))}" fill="#9fc6d6" stroke="#d8d2c4" stroke-width="${r1(s(10))}"/>`,
      );
      for (let i = 0; i < 5; i += 1)
        parts.push(tree(at(0.1 + i * 0.2), ground + s(40), s(120), palette.near));
      break;
    }
    case "mirador": {
      if (plain) {
        parts.push(
          tree(at(0.3), ground + s(30), s(160), palette.near),
          tree(at(0.62), ground + s(60), s(130), palette.middle),
        );
        break;
      }
      // The viewpoint's rocky edge, in front, with its railing on top.
      parts.push(
        `<path d="M${r1(at(0))},${r1(ground + s(420))} L${r1(at(0))},${r1(ground - s(20))} Q${r1(at(0.2))},${r1(ground - s(45))} ${r1(at(0.34))},${r1(ground + s(10))} Q${r1(at(0.42))},${r1(ground + s(60))} ${r1(at(0.46))},${r1(ground + s(420))} Z" fill="${palette.near}"/>`,
      );
      for (let i = 0; i < 6; i += 1) {
        const x = at(0.03 + i * 0.05);
        parts.push(
          `<rect x="${r1(x)}" y="${r1(ground - s(95))}" width="${r1(s(8))}" height="${r1(s(65))}" fill="#5a4636"/>`,
        );
      }
      parts.push(
        `<rect x="${r1(at(0.03))}" y="${r1(ground - s(97))}" width="${r1(span * 0.26)}" height="${r1(s(8))}" fill="#5a4636"/>`,
      );
      parts.push(tree(at(0.7), ground + s(30), s(160), palette.near));
      break;
    }
    case "museo": {
      const cx = at(0.5);
      const w = s(520);
      const h = s(230);
      parts.push(
        `<rect x="${r1(cx - w / 2 - s(30))}" y="${r1(ground - s(30))}" width="${r1(w + s(60))}" height="${r1(s(30))}" fill="#d9d2c3"/>`,
      );
      parts.push(
        `<rect x="${r1(cx - w / 2)}" y="${r1(ground - h - s(30))}" width="${r1(w)}" height="${r1(h)}" fill="#efe9dc"/>`,
      );
      for (let i = 0; i < 6; i += 1) {
        parts.push(
          `<rect x="${r1(cx - w / 2 + s(30) + (i * (w - s(80))) / 5)}" y="${r1(ground - h - s(20))}" width="${r1(s(26))}" height="${r1(h - s(10))}" fill="#ffffff"/>`,
        );
      }
      parts.push(
        `<polygon points="${r1(cx - w / 2 - s(20))},${r1(ground - h - s(30))} ${r1(cx)},${r1(ground - h - s(120))} ${r1(cx + w / 2 + s(20))},${r1(ground - h - s(30))}" fill="#e2d9c6"/>`,
      );
      parts.push(
        `<rect x="${r1(cx - s(40))}" y="${r1(ground - s(130))}" width="${r1(s(80))}" height="${r1(s(100))}" fill="#6b4f3a"/>`,
      );
      parts.push(
        tree(at(0.12), ground, s(170), palette.near),
        tree(at(0.88), ground, s(150), palette.near),
      );
      break;
    }
    case "mercado":
    case "feria": {
      for (let i = 0; i < 5; i += 1)
        parts.push(stall(at(0.04 + i * 0.19), ground + s(30), s(220), palette.accent));
      if (scene === "feria") {
        parts.push(bunting(at(0.02), at(0.5), ground - s(260), s(70), palette.accent));
        parts.push(bunting(at(0.5), at(0.98), ground - s(250), s(80), palette.accent));
      }
      break;
    }
    case "rio": {
      const mid = at(0.5);
      parts.push(
        `<path d="M${r1(mid - s(20))},${r1(ground)} C${r1(mid - s(200))},${r1(ground + s(120))} ${r1(mid + s(300))},${r1(ground + s(200))} ${r1(mid - s(150))},${r1(ground + s(420))} L${r1(mid + s(380))},${r1(ground + s(420))} C${r1(mid + s(520))},${r1(ground + s(200))} ${r1(mid + s(60))},${r1(ground + s(110))} ${r1(mid + s(20))},${r1(ground)} Z" fill="#8cc4d8"/>`,
      );
      for (let i = 0; i < 4; i += 1) {
        parts.push(
          tree(at(0.05 + i * 0.09), ground + s(20 + i * 30), s(140 + i * 30), palette.near),
        );
        parts.push(
          tree(at(0.95 - i * 0.09), ground + s(20 + i * 30), s(140 + i * 30), palette.middle),
        );
      }
      break;
    }
    case "festival": {
      const cx = at(0.5);
      for (let i = 0; i < 5; i += 1) {
        const tx = cx - s(260) + i * s(130);
        parts.push(
          `<polygon points="${r1(tx)},${r1(ground - s(290))} ${r1(tx - s(180))},${r1(ground)} ${r1(tx + s(180))},${r1(ground)}" fill="${palette.accent[i % palette.accent.length]}" opacity="0.18"/>`,
        );
      }
      parts.push(
        `<rect x="${r1(cx - s(330))}" y="${r1(ground - s(300))}" width="${r1(s(660))}" height="${r1(s(22))}" fill="#3c3f58"/>`,
      );
      parts.push(
        `<rect x="${r1(cx - s(360))}" y="${r1(ground - s(70))}" width="${r1(s(720))}" height="${r1(s(70))}" fill="#2a2d42"/>`,
      );
      for (let i = 0; i < 40; i += 1) {
        const t = i / 39;
        const x = at(0.02) + (at(0.98) - at(0.02)) * t;
        const y = ground - s(380) + Math.sin(t * Math.PI * 4) * s(30);
        parts.push(
          `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(s(7))}" fill="${palette.accent[i % palette.accent.length]}"/>`,
        );
      }
      break;
    }
    case "caminata": {
      parts.push(
        `<path d="M${r1(at(0.45))},${r1(ground + s(400))} C${r1(at(0.2))},${r1(ground + s(220))} ${r1(at(0.7))},${r1(ground + s(120))} ${r1(at(0.52))},${r1(ground)}" stroke="#d9c39a" stroke-width="${r1(s(48))}" fill="none" stroke-linecap="round"/>`,
      );
      for (let i = 0; i < 6; i += 1) {
        const x = at(0.08 + i * 0.17);
        parts.push(
          `<rect x="${r1(x)}" y="${r1(ground + s(20) - s(110))}" width="${r1(s(22))}" height="${r1(s(110))}" rx="${r1(s(10))}" fill="${palette.near}"/>`,
        );
        parts.push(
          `<rect x="${r1(x - s(26))}" y="${r1(ground + s(20) - s(80))}" width="${r1(s(16))}" height="${r1(s(46))}" rx="${r1(s(8))}" fill="${palette.near}"/>`,
        );
      }
      break;
    }
  }
  return parts.join("");
}

function landscape(
  scene: SampleScene,
  variant: number,
  width: number,
  height: number,
  periodic: boolean,
): string {
  const palette = SCENE_PALETTE[scene][variant % 2 === 1 ? 0 : 1];
  const next = random(`${scene}:${variant}:${periodic ? "pano" : "photo"}`);
  const horizon = periodic ? height * 0.5 : height * 0.58;
  // In a panorama a quarter of the image fills 90° of view: things are drawn smaller.
  const scale = periodic ? 0.9 : 1;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  parts.push(
    sky(width, horizon, palette, next, periodic ? width * 0.3 : width * (0.2 + next() * 0.6)),
  );
  parts.push(
    ridge({
      width,
      bottom: height,
      base: horizon + 10,
      amplitude: horizon * 0.42,
      next,
      periodic,
      color: palette.far,
      opacity: 0.9,
    }),
  );
  parts.push(
    ridge({
      width,
      bottom: height,
      base: horizon + 25,
      amplitude: horizon * 0.26,
      next,
      periodic,
      color: palette.middle,
    }),
  );
  parts.push(
    `<rect x="0" y="${r1(horizon + 20)}" width="${width}" height="${r1(height - horizon - 20)}" fill="url(#ground)"/>`,
  );
  parts.push(
    ridge({
      width,
      bottom: horizon + 60,
      base: horizon + 40,
      amplitude: horizon * 0.08,
      next,
      periodic,
      color: palette.near,
      opacity: 0.85,
    }),
  );
  const ground = horizon + (periodic ? 120 : 160);
  if (periodic) {
    // Four strips around the viewer, none crossing the seam at the edges.
    const strip = width / 4;
    PANORAMA_STRIPS[scene].forEach(([kind, plain], i) => {
      parts.push(
        foreground(
          kind,
          i * strip + strip * 0.1,
          (i + 1) * strip - strip * 0.1,
          ground,
          scale,
          palette,
          next,
          plain,
        ),
      );
    });
  } else {
    parts.push(foreground(scene, width * 0.04, width * 0.96, ground, scale, palette, next));
  }
  parts.push("</svg>");
  return parts.join("");
}

async function rasterize(svg: string): Promise<Uint8Array> {
  const buffer = await sharp(Buffer.from(svg))
    .jpeg({ quality: 86, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return new Uint8Array(buffer);
}

export function createSharpSampleImageRenderer(): SampleImageRenderer {
  return {
    photo: (scene, variant) =>
      rasterize(landscape(scene, variant, PHOTO.width, PHOTO.height, false)),
    panorama: (scene) => rasterize(landscape(scene, 1, PANORAMA.width, PANORAMA.height, true)),
  };
}

/** For tests and previews: the SVG source of one illustration. */
export function sampleIllustrationSvg(
  scene: SampleScene,
  variant: number,
  panorama = false,
): string {
  return panorama
    ? landscape(scene, variant, PANORAMA.width, PANORAMA.height, true)
    : landscape(scene, variant, PHOTO.width, PHOTO.height, false);
}
