/** Internal directory-operation results. Never expose raw filesystem errors. */
export interface WorkdirProbeRequest {
  kind: 'probe' | 'mkdir' | 'realpath' | 'similar';
  id: number;
  dir: string;
}

export type WorkdirProbeResult =
  | { ok: true; isDirectory: boolean; device?: number; path?: string | null }
  | { ok: false; code: string };

/** A validated path is returned only to the renderer that selected it. */
export type WorkdirValidateResult = { ok: true; realPath: string } | { ok: false; code: string };
export type WorkdirAvailabilityResult = { ok: true; usable: boolean } | { ok: false; code: string };
export type WorkdirOperationKind = WorkdirProbeRequest['kind'] | 'validate' | 'availability';
export type WorkdirOperationResult =
  WorkdirProbeResult | WorkdirValidateResult | WorkdirAvailabilityResult;

export interface WorkdirProbeResponse {
  kind: 'result';
  id: number;
  result: WorkdirProbeResult;
}
