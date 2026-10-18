/**
 * Image identification from the bytes themselves (never from the file name or the type
 * the browser declares). Reads only headers: PNG IHDR, JPEG SOFn and WebP VP8/VP8L/VP8X.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  readonly mime: ImageMime;
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => ((u16be(b, i) << 16) >>> 0) + u16be(b, i + 2);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function png(b: Uint8Array): ImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => b[i] === byte) || ascii(b, 12, 4) !== "IHDR") return null;
  return { mime: "image/png", width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): ImageInfo | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Start-of-frame markers carry the dimensions (C4 DHT, C8 JPG and CC DAC are not frames).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: "image/jpeg", height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before any frame
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webp(b: Uint8Array): ImageInfo | null {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { mime: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const b1 = b[21] ?? 0;
    const b2 = b[22] ?? 0;
    const b3 = b[23] ?? 0;
    const b4 = b[24] ?? 0;
    return {
      mime: "image/webp",
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === "VP8X") {
    return { mime: "image/webp", width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

/** Identifies a PNG, JPEG or WebP image and its pixel size, or returns null. */
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes);
  return info && info.width > 0 && info.height > 0 ? info : null;
}
