import { IOSSimulatorInstanceError } from "./instance-errors.js";

export interface IOSSimulatorRgbaImage {
  width: number;
  height: number;
  /** Unpremultiplied RGBA bytes, four bytes per pixel, row-major. */
  data: Uint8Array;
}

export interface IOSSimulatorPixelDiffOptions {
  /** Per-channel difference at or below this value is ignored. */
  threshold?: number;
}

export interface IOSSimulatorPixelDiff {
  width: number;
  height: number;
  comparedPixels: number;
  differentPixels: number;
  differenceRatio: number;
  meanAbsoluteError: number;
  maxAbsoluteError: number;
  threshold: number;
}

function requireImage(image: IOSSimulatorRgbaImage, name: string): void {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > 8_192 ||
    image.height > 8_192
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `${name} dimensions are invalid`,
    );
  }
  const expectedBytes = image.width * image.height * 4;
  if (image.data.byteLength !== expectedBytes) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `${name} must contain exactly width * height * 4 RGBA bytes`,
    );
  }
}

/** Compare two same-sized RGBA images without producing or persisting a diff image. */
export function compareIOSSimulatorRgbaImages(
  baseline: IOSSimulatorRgbaImage,
  current: IOSSimulatorRgbaImage,
  options: IOSSimulatorPixelDiffOptions = {},
): IOSSimulatorPixelDiff {
  requireImage(baseline, "baseline image");
  requireImage(current, "current image");
  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "baseline and current images must have identical dimensions",
    );
  }
  const threshold = options.threshold ?? 16;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 255) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "pixel diff threshold must be an integer between 0 and 255",
    );
  }
  const comparedPixels = baseline.width * baseline.height;
  let differentPixels = 0;
  let totalAbsoluteError = 0;
  let maxAbsoluteError = 0;
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    let pixelMaximum = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const error = Math.abs(
        baseline.data[offset + channel]! - current.data[offset + channel]!,
      );
      totalAbsoluteError += error;
      pixelMaximum = Math.max(pixelMaximum, error);
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
    }
    if (pixelMaximum > threshold) differentPixels += 1;
  }
  return {
    width: baseline.width,
    height: baseline.height,
    comparedPixels,
    differentPixels,
    differenceRatio: differentPixels / comparedPixels,
    meanAbsoluteError: totalAbsoluteError / baseline.data.length,
    maxAbsoluteError,
    threshold,
  };
}
