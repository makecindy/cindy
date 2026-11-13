/**
 * Remote tool bodies: which tool text a Host may leave out for a controller
 * (docs/dev-rules/protocol-compatibility/device-link-tool-event-body-optional.md).
 *
 * Every rule is opt-in per controller and append-only. A controller that declares
 * none of these keeps receiving exactly the payloads it received before; an old Host
 * ignores the declarations. Old peers on either side therefore behave as before.
 */

/**
 * The controller renders tool results from `resolvedContent` (Desktop) or from
 * `local-db:messages:created` rows (Mobile) and never reads `data.fullText` /
 * `data.summary` of `tool_result` / `tool_result_full` events. The Host drops those two
 * fields for it; the event, its order, ids, `isError` and `resolvedContent` stay.
 */
export const CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1 = 'tool-result-event-text-optional-v1';

/**
 * The controller builds tool rows only from `local-db:messages:created` and treats a
 * `tool_use` event as a boundary. The Host sends `data.input: null` for it, except for
 * Codex `update_plan`, whose live plan snapshot reads the input from the event.
 */
export const CONTROLLER_CAPABILITY_TOOL_USE_EVENT_INPUT_OPTIONAL_V1 = 'tool-use-event-input-optional-v1';
