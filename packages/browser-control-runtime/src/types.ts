/**
 * Neutral browser-control runtime contract used by XDMaker hosts.
 *
 * The concrete runtime can be backed by an upstream-synced implementation. This
 * file is the stable boundary consumed by MCP wrappers and desktop host code.
 */

export type BrowserControlAction =
  | 'doctor'
  | 'status'
  | 'start'
  | 'stop'
  | 'profiles'
  | 'tabs'
  | 'open'
  | 'focus'
  | 'close'
  | 'snapshot'
  | 'screenshot'
  | 'navigate'
  | 'console'
  | 'pdf'
  | 'upload'
  | 'dialog'
  | 'act'
  // Network inspection: read captured XHR/fetch metadata + response bodies
  // (vendored runtime buffers these per-page). Often a page's data is a JSON
  // API — reading it is far cheaper/steadier than scraping rendered DOM.
  | 'requests'
  | 'responseBody';

export type BrowserActKind =
  | 'click'
  | 'clickCoords'
  | 'type'
  | 'press'
  | 'hover'
  | 'drag'
  | 'select'
  | 'fill'
  | 'resize'
  | 'wait'
  | 'evaluate'
  | 'saveResource'
  | 'close';

export type BrowserControlTarget = 'sandbox' | 'host' | 'node';
export type BrowserSnapshotFormat = 'aria' | 'ai';
export type BrowserSnapshotMode = 'efficient';
export type BrowserSnapshotRefs = 'role' | 'aria';
export type BrowserImageType = 'png' | 'jpeg';

/**
 * Backend-neutral element lookup. A query may combine multiple semantic
 * fields; every populated field must match the same element.
 */
export interface BrowserElementQuery {
  css?: string;
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  exact?: boolean;
  index?: number;
}

export interface BrowserActRequest {
  kind: BrowserActKind;
  targetId?: string;
  ref?: string;
  query?: BrowserElementQuery;
  doubleClick?: boolean;
  button?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
  text?: string;
  submit?: boolean;
  slowly?: boolean;
  key?: string;
  delayMs?: number;
  startRef?: string;
  endRef?: string;
  values?: string[];
  fields?: Array<Record<string, unknown>>;
  width?: number;
  height?: number;
  timeMs?: number;
  selector?: string;
  url?: string;
  loadState?: string;
  textGone?: string;
  timeoutMs?: number;
  fn?: string;
}

export interface BrowserControlRequest {
  action: BrowserControlAction;
  target?: BrowserControlTarget;
  node?: string;
  profile?: string;
  targetUrl?: string;
  url?: string;
  targetId?: string;
  label?: string;
  limit?: number;
  maxChars?: number;
  mode?: BrowserSnapshotMode;
  snapshotFormat?: BrowserSnapshotFormat;
  refs?: BrowserSnapshotRefs;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  selector?: string;
  frame?: string;
  labels?: boolean;
  urls?: boolean;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  type?: BrowserImageType;
  level?: string;
  paths?: string[];
  inputRef?: string;
  query?: BrowserElementQuery;
  timeoutMs?: number;
  dialogId?: string;
  accept?: boolean;
  promptText?: string;
  /** `requests`: substring filter over captured request URLs. */
  filter?: string;
  /** `requests`: clear the captured buffer after reading. */
  clear?: boolean;
  request?: BrowserActRequest;
}

export interface BrowserControlResult {
  ok: boolean;
  action: BrowserControlAction;
  status?: number;
  data?: unknown;
  errorCode?: BrowserControlErrorCode;
  message?: string;
}

export type BrowserControlErrorCode =
  | 'BROWSER_RUNTIME_NOT_CONFIGURED'
  | 'BROWSER_RUNTIME_UNAVAILABLE'
  | 'BROWSER_RUNTIME_INVALID_REQUEST'
  | 'BROWSER_RUNTIME_ACTION_FAILED';

export interface BrowserControlRuntime {
  call(request: BrowserControlRequest): Promise<BrowserControlResult>;
}

export interface BrowserControlRuntimeFactoryOptions {
  runtime?: BrowserControlRuntime;
}
