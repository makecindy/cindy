// Covers common 4K/5K/6K screenshots without lifting the 32 Mi-character
// transport limit. Bound decoded pixels before encoding/decoding allocation.
export const CLIPBOARD_IMAGE_PIXELS = 24_000_000;
export const CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
