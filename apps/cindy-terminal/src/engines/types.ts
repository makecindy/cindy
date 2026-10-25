export type EngineKind = 'claude-code' | 'codex' | 'pi';
export interface EngineAsset {
  url: string;
  sha256: string;
  size: number;
  format: 'raw' | 'tar.gz' | 'zip';
  entrypoint: string;
  target?: string;
}
export interface EngineRelease { version: string; assets: Record<string, EngineAsset> }
export interface EngineStatus {
  kind: EngineKind;
  source: 'managed' | 'path' | 'missing';
  binary: string | null;
  version: string | null;
  bundledVersion: string;
}
export class EngineError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EngineError'; }
}
