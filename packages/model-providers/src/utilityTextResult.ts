import type { UtilityModelTransport } from './utilityModelProfiles';

/** A credential-safe explanation for why one utility-model candidate was not usable. */
export type UtilityTextAttemptReason =
  | 'unsupported_transport'
  | 'agent_unavailable'
  | 'model_unavailable'
  | 'not_authenticated'
  | 'auth_probe_failed'
  | 'api_key_missing'
  | 'endpoint_missing'
  | 'timeout'
  | 'empty_response'
  | 'http_error'
  | 'request_failed';

/** Fields shared by every candidate considered by the utility-model fallback chain. */
type UtilityTextAttemptBase = {
  providerId: string;
  model: string;
  transport: UtilityModelTransport;
  status: 'skipped' | 'failed';
};

/** One candidate diagnostic; HTTP status is valid only for HTTP failures. */
export type UtilityTextAttempt =
  | (UtilityTextAttemptBase & {
    reason: 'http_error';
    /** Safe transport metadata; response bodies are deliberately never exposed. */
    httpStatus: number;
  })
  | (UtilityTextAttemptBase & {
    reason: Exclude<UtilityTextAttemptReason, 'http_error'>;
    httpStatus?: never;
  });

/** Stable high-level failure categories shared by desktop UI and scheduler MCP. */
export type UtilityTextFailureReason =
  'no_candidate' | 'all_candidates_failed' | 'empty_response' | 'timeout';

/** Structured diagnostic returned after the configured fallback chain is exhausted. */
export type UtilityTextFailure = {
  ok: false;
  reason: UtilityTextFailureReason;
  attempts: UtilityTextAttempt[];
};

/** Successful utility-model response, including the candidate that produced it. */
export type UtilityTextSuccess = {
  ok: true;
  text: string;
  providerId: string;
  model: string;
  transport: UtilityModelTransport;
};

/** Result of a utility-model text request. Expected availability failures never collapse to null. */
export type UtilityTextResult = UtilityTextSuccess | UtilityTextFailure;
