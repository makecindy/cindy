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
        status: result.effect === 'confirmed' && !isSelectionOnlyClick(name, result) ? 'confirmed' : 'unknown',
        next_step: 'verify_state',
      },
    };
  }
  return { ok: true };
}

/**
 * The driver answers a click on a row label that has no AXPress by writing
 * AXSelected on the row and reports the write-back as confirmed. That proves the
 * selection, not that the app ran its click handler: Xcode's project navigator
 * keeps "No Selection" (2026-11-06). The coordinate-click selection variant
 * delivered a real click and is not matched.
 */
function isSelectionOnlyClick(name: string, result: Record<string, unknown>): boolean {
  return name === 'click'
    && typeof result.summary === 'string'
    && result.summary.includes('Selected nearest ')
    && /confirmed AXSelected=true\.?$/.test(result.summary.trimEnd());
}

const POINTER_TOOLS: ReadonlySet<string> = new Set(['click', 'double_click', 'right_click', 'drag']);
// cua-driver 0.37+ delivery note: "... confirm via screenshot and retry with delivery_mode:"foreground" if nothing changed".
const FOREGROUND_RETRY_PHRASE = 'retry with delivery_mode:"foreground" if nothing changed';

/** Plain string scan: the text comes from the driver, so no backtracking regex runs over it. */
function withoutForegroundRetryAdvice(text: string): string {
  const parts = text.split(FOREGROUND_RETRY_PHRASE);
  // Drop the connective ("... and retry ...") that led into each removed phrase.
  return parts.map((part, index) =>
    index < parts.length - 1 ? part.trimEnd().replace(/ (?:and|or)$/, '') : part).join('');
}

const BACKGROUND_FIRST_HINT = 'If the expected change is missing, first try another background route: the element\'s window-local coordinates, double_click, a menu bar item, a keyboard shortcut or set_value. Foreground delivery moves the person\'s pointer and is refused while they use this computer; use it only when no background route works.';
const SELECTION_ONLY_HINT = 'Only the accessibility selection was written; the app may not have run its click action (Xcode\'s project navigator does not). If the expected change is missing, click the row\'s window-local coordinates or double_click it in the background.';

/**
 * A delivered background pointer action carries driver prose that suggests a
 * foreground retry when nothing changed. That sends the Agent straight into
 * USER_INPUT_ACTIVE while the person is working, although a background route
 * usually exists. Replace that advice and keep every evidence field. Refusals
 * (background_unavailable) are left alone: there the driver has proven that only
 * the foreground can reach the target.
 */
export function normalizePointerAdvice(name: string, data: unknown): unknown {
  if (!POINTER_TOOLS.has(name) || !data || typeof data !== 'object' || Array.isArray(data)) return data;
  const result = data as Record<string, unknown>;
  if (!computerResultOutcome(name, result).ok) return data;
  const stripped = (value: unknown) => typeof value === 'string' ? withoutForegroundRetryAdvice(value) : value;
  const summary = stripped(result.summary);
  const hint = stripped(result.hint);
  const selectionOnly = isSelectionOnlyClick(name, result);
  if (!selectionOnly && summary === result.summary && hint === result.hint) return data;
  const advice = selectionOnly ? SELECTION_ONLY_HINT : BACKGROUND_FIRST_HINT;
  return {
    ...result,
    ...(summary === undefined ? {} : { summary }),
    hint: typeof hint === 'string' && hint.trim() ? `${hint.trim()} ${advice}` : advice,
  };
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
