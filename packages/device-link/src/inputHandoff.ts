/**
 * Input handoff (代输入): the Host reads one screen of a target UI, the owner
 * completes it on any of their devices, and the Host performs it locally.
 *
 * Snapshots carry structure only (labels, options, roles). Values the owner
 * enters travel exclusively through the trusted local Desktop channel or the
 * signed plugin-oauth v3 exchange; they never appear in snapshots, plain
 * interaction decisions, transcripts, logs or IM.
 */

/** Reserved binding id for the v3 signed handshake. Not an installable plugin id. */
export const INPUT_HANDOFF_GHOST_ID = "cindy-input-handoff";
/** Trusted Desktop Renderer → Main only; never add this channel to the remote allowlist. */
export const INPUT_HANDOFF_LOCAL_CHANNEL = "input-handoff:submit";
/** Trusted Desktop IPC that relays one step to another computer over the signed v3 exchange. */
export const INPUT_HANDOFF_REMOTE_LOCAL_CHANNEL = "plugin-oauth:submit-input";
/** Trusted Desktop Renderer → Main only: the current step's screenshot on the executing computer. */
export const INPUT_HANDOFF_LOCAL_PICTURE_CHANNEL = "input-handoff:picture";
/** Trusted Desktop Renderer → Main only: bring the step's window to the front on the executing computer. */
export const INPUT_HANDOFF_LOCAL_RAISE_CHANNEL = "input-handoff:raise";
/**
 * Trusted Desktop IPC pair for a screenshot step of a task on another computer:
 * open receives the sealed picture, answer returns the owner's tap or typing
 * on the same signed exchange. Host-only, like the submit channel.
 */
export const INPUT_HANDOFF_REMOTE_PICTURE_CHANNEL = "plugin-oauth:open-input-picture";
export const INPUT_HANDOFF_REMOTE_PICTURE_ANSWER_CHANNEL = "plugin-oauth:answer-input-picture";
export const INPUT_HANDOFF_VALUE_MAX_CHARS = 4096;
export const INPUT_HANDOFF_MAX_CONTROLS = 40;
export const INPUT_HANDOFF_MAX_OPTIONS = 200;
export const INPUT_HANDOFF_LABEL_MAX_CHARS = 300;
/** Whole-step budget so one signed reply always fits the v3 sealed box. */
export const INPUT_HANDOFF_TOTAL_VALUE_MAX_CHARS = 8192;
/** Presentation labels are shortened so a sealed offer stays small. */
export const INPUT_HANDOFF_PRESENTATION_LABEL_CHARS = 80;
/** Fixed v3 action id: each step is one signed exchange bound to (requestId, revision). */
export const INPUT_HANDOFF_ACTION_ID = "step";
/** Screenshot of one step, JPEG bytes. Sized so one sealed offer carries it with the presentation. */
export const INPUT_HANDOFF_PICTURE_MAX_BYTES = 330_000;
export const INPUT_HANDOFF_PICTURE_MAX_SIDE = 4096;
/** Control id of the text box shown under a screenshot when the window has a focused text field. */
export const INPUT_HANDOFF_PICTURE_TEXT_ID = "typed";
/** Longest QR content carried to an owner device. */
export const INPUT_HANDOFF_QR_TEXT_MAX_CHARS = 2048;

export type InputHandoffContentType =
  | "text"
  | "username"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "password"
  | "one-time-code"
  | "search";

export interface InputHandoffOption {
  id: string;
  label: string;
}

/**
 * What the owner is asked for: only the fields they type into, plus what the
 * page says is wrong with them. Buttons, pick lists and boxes stay with the
 * agent, so they never reach an owner device.
 */
export type InputHandoffControl =
  | {
      id: string;
      kind: "text";
      label: string;
      contentType: InputHandoffContentType;
      placeholder?: string;
      multiline?: true;
      /** The field already contains text. The text itself never leaves the Host. */
      filled?: true;
      /** Combo boxes: options the owner may pick instead of typing. */
      suggestions?: InputHandoffOption[];
    }
  | { id: string; kind: "note"; text: string; tone: "error" };

export type InputHandoffPhase =
  | "reading"
  | "ready"
  | "working"
  | "finishing"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "expired";

export type InputHandoffOriginWarning =
  | "insecure"
  | "ip-address"
  | "local-host"
  | "local-file"
  | "punycode"
  | "embedded-frame";

export type InputHandoffFailure =
  | "permission"
  | "target_gone"
  | "unreadable"
  | "action_failed"
  | "timeout"
  | "unsupported"
  /** The page or window changed between the owner answering and the secret being typed; nothing was filled. */
  | "origin_changed"
  /** This step could not be shown as a screenshot (no screen-recording permission, or the window is hidden). */
  | "picture_unavailable"
  /** The screen has only buttons or options: nothing for the owner to type, so the agent handles it. */
  | "nothing_to_fill"
  /** The computer's screen is locked: nothing is read or typed until the owner unlocks it. */
  | "screen_locked";

export interface InputHandoffSource {
  /** Application name as reported by the operating system. */
  app: string;
  window?: string;
  /** scheme://host[:port] of the web content, when the step is a web page. */
  origin?: string;
  warning?: InputHandoffOriginWarning;
}

/**
 * The owner device currently answering. Host-verified (server-stamped device id
 * or the executing Desktop itself); the name is a display snapshot only.
 */
export interface InputHandoffHolder {
  /** The executing Desktop answered on its own screen. */
  local?: true;
  deviceId?: string;
  name?: string;
  platform?: "mobile" | "desktop";
}

export interface InputHandoffSnapshot {
  kind: "input_handoff";
  requestId: string;
  revision: number;
  phase: InputHandoffPhase;
  /** Agent-supplied purpose, shown as untrusted text. */
  purpose: string;
  /** Optional agent note to the owner, shown labelled as from the agent. */
  note?: string;
  /** Device holding this handoff; other devices may take it over. */
  holder?: InputHandoffHolder;
  /** Who asked: a task title or a teammate name, resolved by the Host. */
  requester?: string;
  /** Terminal prompts (sudo / ssh / git) show the full command instead of a window. */
  command?: string;
  source: InputHandoffSource;
  stepNumber: number;
  controls: InputHandoffControl[];
  /** Epoch ms when the Host hands control back unless the owner says to stay. */
  finishingUntil?: number;
  failure?: InputHandoffFailure;
  /** The target is driven by the agent (for example a CDP-controlled browser). */
  agentControlled?: true;
  /**
   * The step is a QR code cut out of a screenshot the agent supplied, not a
   * window the Host can see: show that the picture came from the agent, and
   * let the owner hand back after scanning (the Host cannot detect it).
   * Older clients ignore it and still show `agentControlled` and skip.
   */
  agentPicture?: true;
  /** Remote controllers may submit values through the signed v3 exchange. */
  remoteInput?: true;
  /** The request has settled; kept briefly for terminal feedback only. */
  terminal?: true;
  /**
   * This step is shown as a screenshot of the window instead of a form: the
   * owner taps on it, and may type into the focused field (the optional text
   * control). The pixels never travel in a snapshot; the executing Desktop
   * reads them locally and other devices receive them inside the sealed offer.
   */
  picture?: true;
  /**
   * Another device may open a live view of just this window (remote desktop is
   * allowed on this computer); input there stays inside the window.
   */
  liveView?: true;
  /**
   * The step is a sign-in: the owner does it on the window itself, on this
   * computer or through the live view. `controls` stay for clients that do not
   * know this, and for devices without a live view.
   */
  directSignIn?: true;
  /**
   * The step only shows a sign-in code and a link to open (device-code
   * sign-in). The owner copies the code and opens the link on their own
   * device; nothing is typed into the window.
   */
  deviceCode?: InputHandoffDeviceCode;
  /**
   * The step is a QR code to scan (scan-to-sign-in). `scan`: the code is on
   * screen; it is also a picture step, and its picture is the code itself,
   * with what the code says. `scanned`: the code went away and the Host is
   * waiting for the sign-in to finish (for example a confirmation on the
   * owner's phone). The code's content never travels in a snapshot.
   */
  qr?: "scan" | "scanned";
}

/**
 * What a QR code on the target says. `url` is present when the content is a
 * link the owner may open on their device; clients re-check with
 * {@link inputHandoffQrLink} before offering to open it.
 */
export interface InputHandoffQr {
  text: string;
  url?: string;
}

/** A QR code's content as a link to open on an owner device. */
export interface InputHandoffQrLink {
  url: string;
  /** Web links: the host. App links (`weixin://…`): the scheme. Shown so the owner sees where it goes. */
  site: string;
  web: boolean;
}

export interface InputHandoffDeviceCode {
  code: string;
  /** Always https; clients re-check with {@link isInputHandoffDeviceCode} before opening. */
  url: string;
  /** `https://host[:port]` of `url`, shown so the owner sees where the link goes. */
  origin: string;
}

/** One step's screenshot. Delivered only through the trusted local channel or a sealed offer. */
export interface InputHandoffPicture {
  mime: "image/jpeg";
  width: number;
  height: number;
  /** Base64 JPEG. */
  data: string;
  /** QR steps: the picture is the code, and this is what it says. */
  qr?: InputHandoffQr;
}

export type InputHandoffValues = Record<string, string>;

export type InputHandoffAction =
  /** Type the values, then confirm the step as the owner would: the page's main button, else Return. */
  | { kind: "submit" }
  /** Screenshot steps: type into the focused field without pressing Return. */
  | { kind: "fill" }
  /** Screenshot steps: click at this point, as fractions (0–1) of the picture's width and height. */
  | { kind: "tap"; x: number; y: number };

export interface InputHandoffSubmission {
  expectedRevision: number;
  values: InputHandoffValues;
  action: InputHandoffAction;
}

/** Value-less decisions; the only ones accepted through the plain interaction channel. */
export type InputHandoffDecision = {
  kind: "input_handoff";
  /**
   * claim: answer on this device (take over from another one).
   * picture: show this step as a screenshot instead of a form; refresh goes back to the form.
   */
  action: "done" | "cancel" | "stay" | "refresh" | "claim" | "picture";
  expectedRevision: number;
};

/** What the owner saw. Both ends derive it with the same function and compare. */
export interface InputHandoffPresentation {
  requestId: string;
  revision: number;
  purpose: string;
  source: InputHandoffSource;
  command: string | null;
  controls: Array<{ id: string; kind: string; label: string }>;
  /** The owner answers on a screenshot of this step. */
  picture: boolean;
  /** The screenshot is a QR code to scan; its content travels with the sealed picture. */
  qr: boolean;
}

export interface InputHandoffOffer {
  kind: "input-entry";
  state: string;
  presentation: InputHandoffPresentation;
  /** Present exactly when the presentation is a screenshot step. */
  picture?: InputHandoffPicture;
}

export interface InputHandoffValueReply {
  kind: "input-value";
  state: string;
  submission: InputHandoffSubmission;
}

const fail = () => new Error("INPUT_HANDOFF_UNAVAILABLE");

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail();
  return raw as Record<string, unknown>;
}

function keysWithin(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

const fraction = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const controlId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value);

const label = (value: unknown, allowEmpty = false): value is string =>
  typeof value === "string" &&
  value.length <= INPUT_HANDOFF_LABEL_MAX_CHARS &&
  (allowEmpty || value.length > 0) &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value);

/** Rejects control characters other than tab and line breaks; passwords may contain anything printable. */
export function parseInputHandoffValue(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > INPUT_HANDOFF_VALUE_MAX_CHARS ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    throw fail();
  return value;
}

/**
 * A device code is safe to show and open: a short code of letters, digits and
 * hyphens, and a plain https link (no credentials) whose origin is the one shown.
 */
export function isInputHandoffDeviceCode(raw: unknown): raw is InputHandoffDeviceCode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const v = raw as Record<string, unknown>;
  if (!keysWithin(v, ["code", "url", "origin"])) return false;
  if (typeof v.code !== "string" || !/^[A-Z0-9](?:[A-Z0-9-]{1,22}[A-Z0-9])$/.test(v.code)) return false;
  if (typeof v.url !== "string" || v.url.length > 2048 || typeof v.origin !== "string") return false;
  let url: URL;
  try {
    url = new URL(v.url);
  } catch {
    return false;
  }
  return url.protocol === "https:" && !url.username && !url.password && url.origin === v.origin;
}

const qrText = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= INPUT_HANDOFF_QR_TEXT_MAX_CHARS &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

/**
 * Content a phone camera would never open: script, inline data, local files
 * and browser internals. Everything else that is a link (http, https, an app
 * link such as `weixin://`) opens like a scanned code would.
 */
const QR_BLOCKED_SCHEMES = new Set(["javascript", "vbscript", "data", "file", "blob", "about", "filesystem"]);

function qrLinkOf(text: string): InputHandoffQrLink | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1]?.toLowerCase();
  if (!scheme || QR_BLOCKED_SCHEMES.has(scheme)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (scheme === "http" || scheme === "https") return url.host ? { url: text, site: url.host, web: true } : null;
  // App links are `scheme://…`; `WIFI:…`, `tel:…` or a vCard are content, not something to open.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? { url: text, site: scheme, web: false } : null;
}

/** What a QR code says, as handed to the owner; null when it cannot be shown. */
export function inputHandoffQrContent(text: string): InputHandoffQr | null {
  const clean = text.trim();
  if (!qrText(clean)) return null;
  return qrLinkOf(clean) ? { text: clean, url: clean } : { text: clean };
}

/** The link a QR code may be opened as on an owner device: its own content, when that is an openable link. */
export function inputHandoffQrLink(qr: InputHandoffQr): InputHandoffQrLink | null {
  if (qr.url === undefined || qr.url !== qr.text) return null;
  return qrLinkOf(qr.url);
}

export function parseInputHandoffQr(raw: unknown): InputHandoffQr {
  const v = object(raw);
  if (!keysWithin(v, ["text"], ["url"]) || !qrText(v.text)) throw fail();
  if (v.url === undefined) return { text: v.text };
  if (typeof v.url !== "string" || !inputHandoffQrLink({ text: v.text, url: v.url })) throw fail();
  return { text: v.text, url: v.url };
}

export function inputHandoffPresentation(snapshot: InputHandoffSnapshot): InputHandoffPresentation {
  return {
    requestId: snapshot.requestId,
    revision: snapshot.revision,
    purpose: snapshot.purpose,
    source: {
      app: snapshot.source.app,
      ...(snapshot.source.window !== undefined
        ? { window: snapshot.source.window.slice(0, INPUT_HANDOFF_PRESENTATION_LABEL_CHARS) }
        : {}),
      ...(snapshot.source.origin !== undefined ? { origin: snapshot.source.origin } : {}),
      ...(snapshot.source.warning !== undefined ? { warning: snapshot.source.warning } : {}),
    },
    command: snapshot.command ?? null,
    controls: snapshot.controls
      .filter((control) => control.kind !== "note")
      .map((control) => ({
        id: control.id,
        kind: control.kind,
        label: control.label.slice(
          0,
          INPUT_HANDOFF_PRESENTATION_LABEL_CHARS,
        ),
      })),
    picture: snapshot.picture === true,
    qr: snapshot.picture === true && snapshot.qr === "scan",
  };
}

export function parseInputHandoffPicture(raw: unknown): InputHandoffPicture {
  const v = object(raw);
  const side = (n: unknown) =>
    Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= INPUT_HANDOFF_PICTURE_MAX_SIDE;
  if (
    !keysWithin(v, ["mime", "width", "height", "data"], ["qr"]) ||
    v.mime !== "image/jpeg" ||
    !side(v.width) ||
    !side(v.height) ||
    typeof v.data !== "string" ||
    v.data.length === 0 ||
    v.data.length > Math.ceil(INPUT_HANDOFF_PICTURE_MAX_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(v.data)
  )
    throw fail();
  return {
    mime: "image/jpeg",
    width: v.width as number,
    height: v.height as number,
    data: v.data,
    ...(v.qr !== undefined ? { qr: parseInputHandoffQr(v.qr) } : {}),
  };
}

function parseSource(raw: unknown): InputHandoffSource {
  const v = object(raw);
  if (
    !keysWithin(v, ["app"], ["window", "origin", "warning"]) ||
    !label(v.app) ||
    (v.window !== undefined && !label(v.window, true)) ||
    (v.origin !== undefined && (typeof v.origin !== "string" || v.origin.length > 512)) ||
    (v.warning !== undefined &&
      !["insecure", "ip-address", "local-host", "local-file", "punycode", "embedded-frame"].includes(
        String(v.warning),
      ))
  )
    throw fail();
  return {
    app: v.app as string,
    ...(v.window !== undefined ? { window: v.window as string } : {}),
    ...(v.origin !== undefined ? { origin: v.origin as string } : {}),
    ...(v.warning !== undefined ? { warning: v.warning as InputHandoffOriginWarning } : {}),
  };
}

export function parseInputHandoffPresentation(raw: unknown): InputHandoffPresentation {
  const v = object(raw);
  if (
    !keysWithin(v, ["requestId", "revision", "purpose", "source", "command", "controls", "picture", "qr"]) ||
    typeof v.picture !== "boolean" ||
    typeof v.qr !== "boolean" ||
    (v.qr && !v.picture) ||
    typeof v.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(v.requestId) ||
    !Number.isSafeInteger(v.revision) ||
    (v.revision as number) < 0 ||
    typeof v.purpose !== "string" ||
    v.purpose.length > 1000 ||
    (v.command !== null && (typeof v.command !== "string" || v.command.length > 2000)) ||
    !Array.isArray(v.controls) ||
    v.controls.length > INPUT_HANDOFF_MAX_CONTROLS
  )
    throw fail();
  const controls = v.controls.map((entry) => {
    const control = object(entry);
    if (
      !keysWithin(control, ["id", "kind", "label"]) ||
      !controlId(control.id) ||
      control.kind !== "text" ||
      !label(control.label, true)
    )
      throw fail();
    return { id: control.id as string, kind: control.kind as string, label: control.label as string };
  });
  return {
    requestId: v.requestId,
    revision: v.revision as number,
    purpose: v.purpose,
    source: parseSource(v.source),
    command: v.command as string | null,
    controls,
    picture: v.picture as boolean,
    qr: v.qr as boolean,
  };
}

export function parseInputHandoffOffer(raw: unknown): InputHandoffOffer {
  const v = object(raw);
  if (
    !keysWithin(v, ["kind", "state", "presentation"], ["picture"]) ||
    v.kind !== "input-entry" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  const presentation = parseInputHandoffPresentation(v.presentation);
  if (presentation.picture !== (v.picture !== undefined)) throw fail();
  const picture = v.picture !== undefined ? parseInputHandoffPicture(v.picture) : undefined;
  // A QR step's picture always says what the code is; any other picture never does.
  if (picture && presentation.qr !== (picture.qr !== undefined)) throw fail();
  return {
    kind: "input-entry",
    state: v.state,
    presentation,
    ...(picture ? { picture } : {}),
  };
}

/**
 * Structural validation only. The Host additionally checks every id against
 * the exact step the owner answered before touching the target.
 */
export function parseInputHandoffSubmission(raw: unknown): InputHandoffSubmission {
  const v = object(raw);
  if (
    !keysWithin(v, ["expectedRevision", "values", "action"]) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0
  )
    throw fail();
  const rawValues = object(v.values);
  const entries = Object.entries(rawValues);
  if (entries.length > INPUT_HANDOFF_MAX_CONTROLS) throw fail();
  const values: InputHandoffValues = {};
  let total = 0;
  for (const [id, value] of entries) {
    if (!controlId(id)) throw fail();
    values[id] = parseInputHandoffValue(value);
    if ((total += values[id].length) > INPUT_HANDOFF_TOTAL_VALUE_MAX_CHARS) throw fail();
  }
  const action = object(v.action);
  let parsed: InputHandoffAction;
  if ((action.kind === "submit" || action.kind === "fill") && keysWithin(action, ["kind"]))
    parsed = { kind: action.kind };
  else if (action.kind === "tap" && keysWithin(action, ["kind", "x", "y"]) && fraction(action.x) && fraction(action.y))
    parsed = { kind: "tap", x: action.x, y: action.y };
  else throw fail();
  return { expectedRevision: v.expectedRevision as number, values, action: parsed };
}

export function parseInputHandoffValueReply(raw: unknown): InputHandoffValueReply {
  const v = object(raw);
  if (
    !keysWithin(v, ["kind", "state", "submission"]) ||
    v.kind !== "input-value" ||
    typeof v.state !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.state)
  )
    throw fail();
  return { kind: "input-value", state: v.state, submission: parseInputHandoffSubmission(v.submission) };
}

export function parseInputHandoffDecision(raw: unknown): InputHandoffDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (
    !keysWithin(v, ["kind", "action", "expectedRevision"]) ||
    v.kind !== "input_handoff" ||
    !["done", "cancel", "stay", "refresh", "claim", "picture"].includes(String(v.action)) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0
  )
    return null;
  return {
    kind: "input_handoff",
    action: v.action as InputHandoffDecision["action"],
    expectedRevision: v.expectedRevision as number,
  };
}

/** Owner-side check that a submission only references controls of the step it answers. */
export function validateInputHandoffSubmissionForStep(
  snapshot: Pick<InputHandoffSnapshot, "revision" | "controls" | "picture">,
  submission: InputHandoffSubmission,
): boolean {
  if (submission.expectedRevision !== snapshot.revision) return false;
  // A tap is only meaningful on a screenshot, and carries nothing else.
  if (submission.action.kind === "tap")
    return snapshot.picture === true && Object.keys(submission.values).length === 0;
  if (submission.action.kind === "fill" && snapshot.picture !== true) return false;
  const fields = new Set(snapshot.controls.filter((control) => control.kind === "text").map((control) => control.id));
  return Object.entries(submission.values).every(([id, value]) => fields.has(id) && typeof value === "string");
}

/** True when a remote client must not run this snapshot's actions. */
export function isInputHandoffActionable(snapshot: InputHandoffSnapshot): boolean {
  return !snapshot.terminal && snapshot.phase === "ready";
}

/**
 * Whether another owner device holds this handoff. The executing Desktop is
 * `{ local: true }`; a remote viewer passes its own device id. Value-less
 * decisions (hand back, cancel, stay) stay available everywhere.
 */
export function inputHandoffHeldElsewhere(
  snapshot: Pick<InputHandoffSnapshot, "holder">,
  viewer: { local: true } | { deviceId: string | null },
): boolean {
  const holder = snapshot.holder;
  if (!holder) return false;
  if ("local" in viewer) return holder.local !== true;
  return holder.local === true || !viewer.deviceId || holder.deviceId !== viewer.deviceId;
}

/**
 * Identity of the screen a draft belongs to. Holder changes and re-reads of the
 * same screen keep the key (so typing is not wiped when this device claims the
 * handoff); any different screen gets a new key and a clean draft.
 */
export function inputHandoffStepKey(
  snapshot: Pick<InputHandoffSnapshot, "requestId" | "stepNumber" | "controls" | "picture" | "qr">,
): string {
  const shape = (snapshot.picture ? "p|" : "") + (snapshot.qr ? `q:${snapshot.qr}|` : "") + snapshot.controls
    .map((c) => (c.kind === "note" ? `n:${c.id}` : `t:${c.id}:${c.label}:${c.contentType}`))
    .join("|");
  let hash = 5381;
  for (let i = 0; i < shape.length; i++) hash = ((hash << 5) + hash + shape.charCodeAt(i)) | 0;
  return `${snapshot.requestId}:${snapshot.stepNumber}:${(hash >>> 0).toString(36)}`;
}
