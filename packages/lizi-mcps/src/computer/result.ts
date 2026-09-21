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
