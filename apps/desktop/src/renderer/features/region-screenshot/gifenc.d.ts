declare module 'gifenc' {
  export function quantize(data: Uint8Array | Uint8ClampedArray, colors: number, options?: { format?: 'rgb565' | 'rgb444' }): number[][];
  export function applyPalette(data: Uint8Array | Uint8ClampedArray, palette: number[][], format?: 'rgb565' | 'rgb444'): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: { palette: number[][]; delay: number; repeat?: number }): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array;
  };
}
