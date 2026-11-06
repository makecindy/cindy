/** Only explicit driver failure signals override legacy/partial observation success. */
export function isUnavailableWindowObservation(
  data: unknown,
  args: Record<string, unknown>,
): boolean {
  const captureMode = typeof args.screenshot_out_file === 'string' || args.include_screenshot === true
    ? 'vision'
    : args.include_screenshot === false ? 'ax' : args.capture_mode;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const state = data as Record<string, unknown>;
  if (state.ok === false || state.isError === true) return true;
  const screenshotFailed =
    state.screenshot_frame_valid === false ||
    (state.screenshot_error !== undefined && state.screenshot_error !== null);
  const hasElements =
    Array.isArray(state.elements) && state.elements.length > 0;
  const hasTree =
    typeof state.tree_markdown === 'string' &&
    state.tree_markdown.trim().length > 0;
  const axUnavailable = state.degraded === true && !hasElements && !hasTree;
  // A screenshot explicitly requested by vision/SOM cannot be replaced by an AX tree.
  // Conversely, a valid vision-only result may have no AX surface or input route.
  if (captureMode === 'vision' || captureMode === 'som')
    return screenshotFailed;
  if (captureMode === 'ax') return axUnavailable;
  return screenshotFailed && axUnavailable;
}

/** Tool delivery is separate from evidence that a requested postcondition holds. */
export function computerResultOutcome(
  name: string,
  data: unknown,
): {
  ok: boolean;
  errorCode?: string;
  outcome?: {
    status: 'confirmed' | 'unknown' | 'failed';
    next_step: 'verify_state' | 'fresh_state' | 'done';
  };
} {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return name === 'verify_state'
      ? {
          ok: false,
          errorCode: 'POSTCONDITION_NOT_SATISFIED',
          outcome: { status: 'unknown', next_step: 'fresh_state' },
        }
      : { ok: true };
  }
  const result = data as Record<string, unknown>;
  const failure = result.ok === false || result.isError === true || result.effect === 'refused';
  if (failure) {
    return {
      ok: false,
      errorCode: typeof result.code === 'string' ? result.code : 'COMPUTER_DRIVER_ERROR',
      outcome: { status: 'failed', next_step: 'fresh_state' },
    };
  }
  if (name === 'verify_state') {
    const satisfied = result.status === 'satisfied' && result.stable !== false;
    return {
      ok: satisfied,
      ...(!satisfied ? { errorCode: 'POSTCONDITION_NOT_SATISFIED' } : {}),
      outcome: {
        status: satisfied ? 'confirmed' : result.status === 'unsatisfied' ? 'failed' : 'unknown',
        next_step: satisfied ? 'done' : 'fresh_state',
      },
    };
  }
  if (typeof result.effect === 'string') {
    return {
      ok: true,
      outcome: {
        status: result.effect === 'confirmed' ? 'confirmed' : 'unknown',
        next_step: 'verify_state',
      },
    };
  }
  return { ok: true };
}

/** Driver recovery prose may advertise parameters/routes the Cindy MCP does not expose. */
export function normalizeInputFailureAdvice(name: string, code: string | undefined, data: unknown): unknown {
  if (name !== 'type_text' || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  let message: string;
  if (code === 'background_unavailable') {
    message = 'Background text input was refused. Stop and report the refusal; do not switch to foreground or shell-simulated input to bypass it. For Electron/browser/web-content fields, use get_window_state to inspect the target; set_value with a fresh element_token is the supported text route when continuing is appropriate. Cindy type_text does not accept x/y.';
  } else if (code === 'type_text_incomplete') {
    message = 'Text input did not complete; some characters may already have been delivered. Do not resend the text or its suffix, switch delivery modes, or use shell-simulated input. Stop and report the incomplete input. Use get_window_state to inspect the current field before deciding how to continue; a successful observation does not mean the input completed.';
  } else {
    return data;
  }
  // Replace conflicting recovery prose, not the error code, progress or uncertainty.
  const { lastResult, ...evidence } = withoutRecoveryAdvice(data as Record<string, unknown>);
  // Chunked type_text nests the raw refused chunk result, which carries the same prose.
  const nested = lastResult && typeof lastResult === 'object' && !Array.isArray(lastResult)
    ? { lastResult: withoutRecoveryAdvice(lastResult as Record<string, unknown>) }
    : lastResult === undefined ? {} : { lastResult };
  return { ...evidence, ...nested, message };
}

function withoutRecoveryAdvice(value: Record<string, unknown>): Record<string, unknown> {
  const { message: _message, hint: _hint, next_call: _nextCall, summary: _summary, escalation: _escalation, ...rest } = value;
  return rest;
}
