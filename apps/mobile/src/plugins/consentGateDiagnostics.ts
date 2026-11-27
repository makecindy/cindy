import { mobileDebugEnabled, mobileDebugLog } from "@/debug/mobileDebugLog";

/** The phone-local Debug log keyword for the iOS confirmation sheet's tier decisions and Allow presses. */
export const CONSENT_GATE_LOG = "consent-gate";

/** Where every value below comes from, so one record reads on its own. */
export const CONSENT_GATE_SOURCES = {
  window: "useWindowDimensions (layout key: width x height @ fontScale)",
  insets: "useSafeAreaInsets top / bottom",
  visible: "list scrollGeometry.containerHeight (the same the fade reads)",
  content: "list scrollGeometry.contentHeight (the same the fade reads)",
  offset: "list scrollGeometry.contentOffsetY, latest; rest = the first for this key",
  listY: "list onGeometryChange frame.y (global)",
  identity: "identity block onGeometryChange frame y / height (global)",
  identityEnd: "stored: identity bottom - listY, taken only while offset = rest",
  identityEndNow: "the same from the latest frames, whether at rest or not",
  fade: "CONSENT_FADE_HEIGHT when content > visible + 1, else 0; fadeStart = visible - fade",
  heading: "pinned summary heading onGeometryChange height",
  actions: "footer buttons onGeometryChange height",
  lines: "pinned summary lines onGeometryChange heights (0 = not yet)",
  available: "estimate: window - insets - header and footer constants - actions",
  settledMs: "time since any stored size last changed (performance.now)",
} as const;

export interface ConsentGateValues {
  event: "tier" | "allow";
  /** Allow press only: what the press did. */
  result?: "answered" | "review" | "cramped" | "reviewed";
  tier: "regular" | "compact";
  /** Why compact: any of plan, reviewed, cramped, landscape. */
  why: string[];
  window: { width: number; height: number; fontScale: number };
  insets: { top: number; bottom: number };
  visible: number;
  content: number;
  scrolls: boolean;
  fade: number;
  fadeStart: number;
  offset?: number;
  rest?: number;
  atRest: boolean;
  listY?: number;
  identity?: { y: number; height: number };
  identityEnd: number;
  identityEndNow?: number;
  heading: number;
  actions: number;
  lines: number[];
  available: number;
  plan: "regular" | "compact";
  measuredAll: boolean;
  identityShown: boolean;
  regularConfirmed: boolean;
  settledMs: number;
}

/**
 * Development and mock builds only (`isDev` is injected by tests): records every value the iOS confirmation sheet's
 * real-layout gate reads, and where each comes from, into the phone-local Debug log when it is recording. Sizes and
 * positions only: no plugin, source, request or account data.
 */
export function logConsentGate(values: () => ConsentGateValues, isDev: boolean = typeof __DEV__ !== "undefined" && __DEV__): void {
  if (!isDev || !mobileDebugEnabled()) return;
  mobileDebugLog("debug", "plugins", CONSENT_GATE_LOG, { ...values(), from: CONSENT_GATE_SOURCES });
}
