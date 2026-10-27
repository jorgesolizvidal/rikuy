import { inspectImage } from "@rikuy/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createSharpSampleImageRenderer, sampleIllustrationSvg } from "./sample-images";
import { isPermanentSmtpError } from "./smtp-mailer";

describe("sample illustrations", () => {
  const renderer = createSharpSampleImageRenderer();

  it("draws JPEG photos the upload rules accept, always the same for the same input", async () => {
    const photo = await renderer.photo("plaza", 1);
    expect(inspectImage(photo)).toMatchObject({ mime: "image/jpeg", width: 1600, height: 1067 });
    expect(photo.byteLength).toBeLessThan(1024 * 1024);
    expect(sampleIllustrationSvg("plaza", 1)).toBe(sampleIllustrationSvg("plaza", 1));
    expect(sampleIllustrationSvg("plaza", 1)).not.toBe(sampleIllustrationSvg("plaza", 2));
    // Pure shapes: no text, no external reference.
    expect(sampleIllustrationSvg("festival", 1)).not.toMatch(/<text|href|<image/u);
  });

  it("draws 2:1 panoramas whose left and right edges meet", async () => {
    const panorama = await renderer.panorama("mirador");
    expect(inspectImage(panorama)).toMatchObject({ mime: "image/jpeg", width: 4096, height: 2048 });
    const { data, info } = await sharp(panorama).raw().toBuffer({ resolveWithObject: true });
    let difference = 0;
    for (let y = 0; y < info.height; y += 8) {
      for (let c = 0; c < 3; c += 1) {
        const left = data[y * info.width * 3 + c] ?? 0;
        const right = data[(y * info.width + info.width - 1) * 3 + c] ?? 0;
        difference = Math.max(difference, Math.abs(left - right));
      }
    }
    expect(difference).toBeLessThan(24);
  }, 30_000);
});

describe("SMTP errors", () => {
  it("treats refusals as final and everything else as worth retrying", () => {
    expect(isPermanentSmtpError({ responseCode: 550 })).toBe(true);
    expect(isPermanentSmtpError({ responseCode: 535, code: "EAUTH" })).toBe(true);
    expect(isPermanentSmtpError({ responseCode: 421 })).toBe(false);
    expect(isPermanentSmtpError({ code: "ETIMEDOUT" })).toBe(false);
    expect(isPermanentSmtpError(new Error("socket hang up"))).toBe(false);
  });
});
