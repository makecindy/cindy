/**
 * workdir probe host wire format.
 *
 * The utility process only returns a boolean or a stable filesystem error code.
 * It never returns the probed path or the host error message to avoid leaking
 * local filesystem details across the process boundary.
 */

export interface WorkdirProbeRequest {
  kind: 'probe';
  id: number;
  dir: string;
}

export type WorkdirProbeResult =
  | { ok: true; isDirectory: boolean }
  | { ok: false; code: string };

export interface WorkdirProbeResponse {
  kind: 'result';
  id: number;
  result: WorkdirProbeResult;
}
