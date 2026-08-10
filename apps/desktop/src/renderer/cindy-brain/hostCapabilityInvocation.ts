/**
 * Host capability invocation metadata for user messages.
 *
 * A Host capability Plugin is not a normal command Plugin: selecting it must
 * route the Agent to a Cindy-owned capability and must never synthesize a
 * `ghost_call`. The deterministic suffix below serves two purposes:
 *
 * - it tells the Agent which Host route the user explicitly selected;
 * - it persists enough structured identity for UserMessage to render the same
 *   invocation annotation used by command Plugins.
 *
 * Generation and parsing share one exact template. Anything that does not
 * match the complete suffix remains ordinary user text.
 */

import type { GhostDirectiveSegment } from './ghostCommand';

export interface HostCapabilitySelection {
  capability: string;
  ghostId: string;
  name: string;
}

export interface HostCapabilityDirectiveDisplay extends HostCapabilitySelection {
  kind: 'host-capability';
  route: string;
  raw: string;
}

export function routeForHostCapability(capability: string): string {
  return capability === 'ios-simulator' ? 'cindy_ios_simulator' : capability;
}

/** The exact suffix sent to the Agent and shown in the invocation details. */
export function hostCapabilityDirectiveSegments(
  selection: HostCapabilitySelection & { route?: string },
): GhostDirectiveSegment[] {
  const route = selection.route ?? routeForHostCapability(selection.capability);
  return [
    { text: '[Cindy Host 能力] 用户显式选择了「', injected: false },
    { text: selection.name, injected: true },
    { text: '」(capability: ', injected: false },
    { text: selection.capability, injected: true },
    { text: ', plugin id: ', injected: false },
    { text: selection.ghostId, injected: true },
    { text: ', route: ', injected: false },
    { text: route, injected: true },
    {
      text:
        ')。必须使用 Cindy Host 的上述 route 完成本请求；这是 Host 能力，不是普通插件命令，' +
        '不要通过 ghost_call 调用。',
      injected: false,
    },
  ];
}

function buildHostCapabilityDirective(selection: HostCapabilitySelection): string {
  return hostCapabilityDirectiveSegments(selection)
    .map((segment) => segment.text)
    .join('');
}

/**
 * Append Host routing metadata without changing the user's own body.
 * `defaultPrompt` is used only when the capability chip was sent by itself.
 */
export function expandHostCapabilityInvocation(
  text: string,
  selection: HostCapabilitySelection,
  defaultPrompt: string,
): string {
  const body = text.trim() ? text : defaultPrompt;
  const directive = buildHostCapabilityDirective(selection);
  return `${body}\n\n${directive}`;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const P1 = '\u0001';
const P2 = '\u0002';
const P3 = '\u0003';
const P4 = '\u0004';

const HOST_CAPABILITY_DIRECTIVE_RE = new RegExp(
  `\\n\\n(${escapeRegExp(
    hostCapabilityDirectiveSegments({ capability: P1, name: P2, ghostId: P3, route: P4 })
      .map((segment) => segment.text)
      .join(''),
  )
    .replace(P1, '([^,)]+?)')
    .replace(P2, '(.+?)')
    .replace(P3, '([^,)]+?)')
    .replace(P4, '([^,)]+?)')})$`,
);

/** Split a complete persisted Host capability suffix from the visible body. */
export function splitHostCapabilityDirective(
  content: string,
): { body: string; directive: HostCapabilityDirectiveDisplay } | null {
  const match = HOST_CAPABILITY_DIRECTIVE_RE.exec(content);
  if (!match) return null;
  return {
    body: content.slice(0, match.index),
    directive: {
      kind: 'host-capability',
      raw: match[1],
      // Capture groups follow placeholder occurrence in the template: name
      // appears before capability even though their constants are P2 / P1.
      name: match[2],
      capability: match[3],
      ghostId: match[4],
      route: match[5],
    },
  };
}
