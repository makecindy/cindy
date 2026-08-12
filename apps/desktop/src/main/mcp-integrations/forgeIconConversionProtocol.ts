export interface ForgeIconConversionRequest {
  kind: 'convert';
  id: string;
  absPath: string;
  timeoutSeconds: number;
}

export type ForgeIconConversionResponse =
  | { kind: 'result'; id: string; ok: true; png: Uint8Array }
  | { kind: 'result'; id: string; ok: false; error: string };
