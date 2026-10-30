/**
 * workdir probe host wire format.
 *
 * The utility process returns directory status/device identity or a stable filesystem error code.
 * Resolved paths are internal Main/utility data, never controller responses.
 * Host error messages are not returned.
 */

export interface WorkdirProbeRequest {
  kind: 'probe' | 'mkdir' | 'realpath' | 'similar';
  id: number;
  dir: string;
}

export type WorkdirProbeResult =
  | { ok: true; isDirectory: boolean; device?: number; path?: string | null }
  | { ok: false; code: string };

export interface WorkdirProbeResponse {
  kind: 'result';
  id: number;
  result: WorkdirProbeResult;
}
