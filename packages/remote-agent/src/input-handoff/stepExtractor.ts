import {
  INPUT_HANDOFF_LABEL_MAX_CHARS,
  INPUT_HANDOFF_MAX_CONTROLS,
  INPUT_HANDOFF_MAX_OPTIONS,
  type InputHandoffContentType,
  type InputHandoffControl,
  type InputHandoffDeviceCode,
  type InputHandoffSource,
} from '@cindy/device-link';
import type { ControlBinding, NativeAxNode, NativeAxSnapshot, ScreenControl } from './types.js';
import { classifyOrigin, isBrowserBundle } from './originPolicy.js';
import { findDeviceCode } from './deviceCode.js';

/**
 * Maps one native accessibility snapshot to a card step.
 *
 * Generic by design: no site or product knowledge. Web pages are scoped to
 * their visible page area (not the browser toolbar); native windows use every
 * visible control. Text-field values are never part of the input.
 */

export interface ExtractedStep {
  /** Everything readable on the step; the Host keeps it to act and to detect changes. */
  controls: ScreenControl[];
  /**
   * What the owner is asked for: the text fields to type into and any error
   * about them. Empty when the step has nothing to type; buttons, pick lists,
   * boxes, headings and links stay with the agent.
   */
  shown: InputHandoffControl[];
  bindings: Map<string, ControlBinding>;
  source: InputHandoffSource;
  /** Stable when the visible structure is unchanged; used for settle and change detection. */
  signature: string;
  hasSecure: boolean;
  /** Full page URL of the scoped web content, for completion hints only. */
  url?: string;
  /** All visible text, for completion hints only. Never shown to the agent. */
  texts: string[];
  /** A sign-in code plus a link to open elsewhere, when that is all the step asks for. */
  deviceCode?: InputHandoffDeviceCode;
}

const SKIPPED_SUBROLES = new Set([
  'AXCloseButton',
  'AXMinimizeButton',
  'AXZoomButton',
  'AXFullScreenButton',
  'AXToolbarButton',
  'AXSortButton',
  'AXIncrementArrow',
  'AXDecrementArrow',
]);
const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox', 'AXDateTimeArea']);
const BUTTON_ROLES = new Set(['AXButton', 'AXLink', 'AXMenuButton', 'AXDisclosureTriangle', 'AXMenuItem']);
const PRIMARY_LABEL =
  /^(next|continue|sign ?in|log ?in|login|submit|confirm|allow|authori[sz]e|accept|approve|ok|done|verify|send|proceed|下一步|继续|登录|登入|提交|确认|确定|允许|授权|同意|验证|完成|发送|进入)\b/i;

const clip = (text: string) =>
  text.replace(/\s+/g, ' ').trim().slice(0, INPUT_HANDOFF_LABEL_MAX_CHARS);

function visible(node: NativeAxNode, windowFrame: number[]): boolean {
  const frame = node.frame;
  if (!frame || frame.length !== 4) return false;
  const [x, y, w, h] = frame;
  if (w < 2 || h < 2) return false;
  if (windowFrame.length !== 4) return true;
  const [wx, wy, ww, wh] = windowFrame;
  return x + w > wx && y + h > wy && x < wx + ww && y < wy + wh;
}

const isWithin = (ref: string, scope: string) => ref === scope || ref.startsWith(`${scope}.`);
const parentRef = (ref: string) => ref.slice(0, Math.max(0, ref.lastIndexOf('.')));

function area(node: NativeAxNode): number {
  return node.frame && node.frame.length === 4 ? node.frame[2] * node.frame[3] : 0;
}

function ownLabel(node: NativeAxNode): string | undefined {
  for (const candidate of [node.titleElement, node.title, node.desc, node.placeholder, node.help]) {
    if (candidate && candidate.trim()) return clip(candidate);
  }
  return undefined;
}

function buttonLabel(node: NativeAxNode): string | undefined {
  for (const candidate of [node.title, node.desc, node.value, node.titleElement, node.help]) {
    if (candidate && candidate.trim()) return clip(candidate);
  }
  return undefined;
}

function textOf(node: NativeAxNode): string | undefined {
  for (const candidate of [node.value, node.title, node.desc]) {
    if (candidate && candidate.trim()) return clip(candidate);
  }
  return undefined;
}

/** Nearest preceding static text above or to the left of the field. */
function nearbyLabel(field: NativeAxNode, texts: Array<{ node: NativeAxNode; index: number }>, index: number) {
  const frame = field.frame!;
  let best: { text: string; distance: number } | undefined;
  for (const entry of texts) {
    if (entry.index >= index) break;
    const label = textOf(entry.node);
    const other = entry.node.frame;
    if (!label || !other || label.length > 80) continue;
    const above = other[1] + other[3] <= frame[1] + 4 && frame[1] - (other[1] + other[3]) <= 48 &&
      other[0] < frame[0] + frame[2] && other[0] + other[2] > frame[0] - 8;
    const left = Math.abs(other[1] + other[3] / 2 - (frame[1] + frame[3] / 2)) <= frame[3] &&
      other[0] + other[2] <= frame[0] + 4 && frame[0] - (other[0] + other[2]) <= 240;
    if (!above && !left) continue;
    const distance = above ? frame[1] - (other[1] + other[3]) : frame[0] - (other[0] + other[2]);
    if (!best || distance <= best.distance) best = { text: label, distance };
  }
  return best?.text;
}

export function contentTypeFor(node: NativeAxNode, label: string): InputHandoffContentType {
  if (node.secure) return 'password';
  const hint = [label, node.placeholder, node.domId, node.desc, node.title].filter(Boolean).join(' ');
  if (/(one[- ]?time|\botp\b|verification code|security code|auth(entication)? code|2fa|two[- ]?(factor|step)|验证码|动态码|校验码|安全码)/i.test(hint))
    return 'one-time-code';
  if (/(e-?mail|邮箱|邮件)/i.test(hint)) return 'email';
  if (/(phone|mobile|\btel\b|手机|电话)/i.test(hint)) return 'tel';
  if (/(user ?name|\blogin\b|account|用户名|账号|帐号|工号|登录名)/i.test(hint)) return 'username';
  if (/(\burl\b|website|网址|域名)/i.test(hint)) return 'url';
  if (node.role === 'AXSearchField' || node.subrole === 'AXSearchField' || /(search|搜索)/i.test(hint))
    return 'search';
  return 'text';
}

function signatureOf(source: InputHandoffSource, controls: ScreenControl[]): string {
  return JSON.stringify([
    source.app,
    source.window ?? '',
    source.origin ?? '',
    controls.map((control) =>
      control.kind === 'note'
        ? ['n', control.tone, control.text]
        : control.kind === 'choice'
          ? ['c', control.label, control.selected ?? '', control.options.length]
          : control.kind === 'toggle'
            ? ['t', control.label, control.checked]
            : control.kind === 'text'
              ? ['x', control.label, control.contentType, control.filled ?? false]
              : ['b', control.label],
    ),
  ]);
}

export function extractStep(snapshot: NativeAxSnapshot): ExtractedStep {
  const windowFrame = snapshot.window.frame ?? [];
  const browser = isBrowserBundle(snapshot.bundleId);
  const nodes = snapshot.nodes.filter((node) => visible(node, windowFrame));

  // Scope web pages to their largest visible web area (drops browser toolbars and tab strips).
  const webAreas = nodes.filter((node) => node.role === 'AXWebArea');
  const topWeb = webAreas
    .filter((area) => !webAreas.some((other) => other !== area && isWithin(area.ref, other.ref)))
    .sort((a, b) => area(b) - area(a))[0];
  const scoped = topWeb ? nodes.filter((node) => isWithin(node.ref, topWeb.ref)) : nodes;

  // Modal sheets take over the window.
  const sheet = scoped.find((node) => node.role === 'AXSheet');
  const inScope = sheet ? scoped.filter((node) => isWithin(node.ref, sheet.ref)) : scoped;

  const origin = topWeb?.url && (browser || /^https?:/i.test(topWeb.url))
    ? classifyOrigin(topWeb.url, browser)
    : undefined;

  const textNodes: Array<{ node: NativeAxNode; index: number }> = [];
  inScope.forEach((node, index) => {
    if (node.role === 'AXStaticText') textNodes.push({ node, index });
  });

  const controls: ScreenControl[] = [];
  const bindings = new Map<string, ControlBinding>();
  const usedLabels = new Set<string>();
  const radioGroups = new Map<string, { label: string; members: NativeAxNode[] }>();
  let next = 0;
  const id = () => `c${next++}`;
  /** Where each control sits in the tree, to place explanatory lines in reading order. */
  const refs = new Map<string, string>();
  let hasSecure = false;
  let lastTextControl: Extract<InputHandoffControl, { kind: 'text' }> | undefined;

  const groupOf = (radio: NativeAxNode): string => {
    const group = inScope
      .filter((node) => (node.role === 'AXRadioGroup' || node.role === 'AXTabGroup') && isWithin(radio.ref, node.ref))
      .sort((a, b) => b.ref.length - a.ref.length)[0];
    return group?.ref ?? parentRef(radio.ref);
  };

  inScope.forEach((node, index) => {
    if (node.subrole && SKIPPED_SUBROLES.has(node.subrole)) return;
    if (TEXT_ROLES.has(node.role)) {
      const label = ownLabel(node) ?? nearbyLabel(node, textNodes, index) ?? '';
      if (label) usedLabels.add(label);
      let contentType = contentTypeFor(node, label);
      if (contentType === 'password') {
        hasSecure = true;
        // Pair the preceding field as the account for password managers.
        if (lastTextControl && (lastTextControl.contentType === 'text' || lastTextControl.contentType === 'email'))
          lastTextControl.contentType = 'username';
      }
      const controlId = id();
      const suggestions = node.role === 'AXComboBox' && node.options?.length
        ? node.options.slice(0, INPUT_HANDOFF_MAX_OPTIONS).map((option, i) => ({ id: `o${i}`, label: clip(option) }))
        : undefined;
      const control: Extract<InputHandoffControl, { kind: 'text' }> = {
        id: controlId,
        kind: 'text',
        label,
        contentType,
        ...(node.placeholder && node.placeholder !== label ? { placeholder: clip(node.placeholder) } : {}),
        ...(node.role === 'AXTextArea' ? { multiline: true as const } : {}),
        ...(node.hasValue ? { filled: true as const } : {}),
        ...(suggestions ? { suggestions } : {}),
      };
      controls.push(control);
      lastTextControl = control;
      bindings.set(controlId, { kind: 'text', ref: node.ref, fp: node.fp, secure: !!node.secure });
      refs.set(controlId, node.ref);
      return;
    }
    // Pop-ups, boxes and radios are the agent's to operate; they are read only to tell steps apart.
    if (node.role === 'AXPopUpButton' && (node.options?.length || node.value)) {
      const label = ownLabel(node) ?? nearbyLabel(node, textNodes, index) ?? '';
      const options = (node.options ?? []).slice(0, INPUT_HANDOFF_MAX_OPTIONS).map((option, i) => ({
        id: `o${i}`,
        label: clip(option),
      }));
      const controlId = id();
      const selected = options.find((option) => option.label === node.value)?.id;
      controls.push({ id: controlId, kind: 'choice', label, options, ...(selected ? { selected } : {}) });
      refs.set(controlId, node.ref);
      return;
    }
    if (node.role === 'AXCheckBox') {
      const label = buttonLabel(node) ?? nearbyLabel(node, textNodes, index);
      if (!label) return;
      const controlId = id();
      controls.push({ id: controlId, kind: 'toggle', label, checked: !!node.checked });
      refs.set(controlId, node.ref);
      return;
    }
    if (node.role === 'AXRadioButton') {
      const key = groupOf(node);
      const groupNode = inScope.find((candidate) => candidate.ref === key);
      const existing = radioGroups.get(key);
      if (existing) {
        existing.members.push(node);
        return;
      }
      const label = (groupNode && ownLabel(groupNode)) ?? '';
      radioGroups.set(key, { label, members: [node] });
      // Placeholder keeps document order; filled in below.
      controls.push({ id: `radio:${key}`, kind: 'choice', label, options: [] });
      return;
    }
    if (BUTTON_ROLES.has(node.role) || (node.role === 'AXPopUpButton')) {
      const label = buttonLabel(node);
      if (!label) return;
      const controlId = id();
      controls.push({
        id: controlId,
        kind: 'button',
        label,
        ...(node.role === 'AXLink' ? { link: true as const } : {}),
      });
      bindings.set(controlId, { kind: 'press', ref: node.ref, fp: node.fp });
      refs.set(controlId, node.ref);
      return;
    }
    if (node.role === 'AXHeading') {
      const text = textOf(node);
      if (text) controls.push({ id: id(), kind: 'note', tone: 'heading', text });
      return;
    }
    if (node.role === 'AXStaticText' && node.alert) {
      const text = textOf(node);
      if (text) controls.push({ id: id(), kind: 'note', tone: 'error', text });
    }
  });

  // Resolve radio placeholders into choices.
  for (let i = 0; i < controls.length; i++) {
    const control = controls[i];
    if (control.kind !== 'choice' || !control.id.startsWith('radio:')) continue;
    const group = radioGroups.get(control.id.slice('radio:'.length))!;
    const controlId = id();
    const shown = group.members
      .map((member) => ({ member, label: buttonLabel(member) }))
      .filter((entry): entry is { member: NativeAxNode; label: string } => !!entry.label)
      .slice(0, INPUT_HANDOFF_MAX_OPTIONS)
      .map((entry, index) => ({ id: `o${index}`, label: entry.label, checked: !!entry.member.checked }));
    if (shown.length === 0) {
      controls.splice(i--, 1);
      continue;
    }
    const selected = shown.find((option) => option.checked)?.id;
    controls[i] = {
      id: controlId,
      kind: 'choice',
      label: group.label,
      options: shown.map(({ id: optionId, label }) => ({ id: optionId, label })),
      ...(selected ? { selected } : {}),
    };
    refs.set(controlId, group.members[0].ref);
  }

  // Short pages: a few explanatory lines that are not field labels, so a changed message counts as a new step.
  const interactive = controls.filter((control) => control.kind !== 'note').length;
  if (interactive <= 12 && textNodes.length <= 24) {
    let added = 0;
    for (const { node, index } of textNodes) {
      if (added >= 3 || node.alert) continue;
      const text = textOf(node);
      if (!text || text.length < 4 || usedLabels.has(text)) continue;
      if (controls.some((control) => control.kind !== 'note' && control.label === text)) continue;
      // Insert before the first control that comes after this text in document order.
      const position = controlIndexAfter(inScope, controls, refs, index);
      controls.splice(position, 0, { id: id(), kind: 'note', tone: 'info', text });
      added++;
    }
  }

  // Exactly one primary action: the first labelled like a submit, after the last input.
  const lastInput = controls.reduce((last, control, i) => (
    control.kind === 'text' || control.kind === 'choice' || control.kind === 'toggle' ? i : last
  ), -1);
  const primary = controls.findIndex(
    (control, i) => control.kind === 'button' && !control.link && i > lastInput && PRIMARY_LABEL.test(control.label),
  );
  if (primary >= 0) (controls[primary] as Extract<ScreenControl, { kind: 'button' }>).primary = true;

  const capped = capControls(controls, bindings);
  const source: InputHandoffSource = {
    app: clip(snapshot.app) || snapshot.bundleId || 'App',
    ...(snapshot.window.title ? { window: clip(snapshot.window.title) } : {}),
    ...(origin?.origin ? { origin: origin.origin } : {}),
    ...(origin?.warning ? { warning: origin.warning } : {}),
  };
  if (!source.warning && topWeb && hasSecure) {
    // A password field inside a nested page from another origin.
    const secureNode = inScope.find((node) => node.secure);
    const frameArea = secureNode && webAreas
      .filter((area) => area !== topWeb && isWithin(secureNode.ref, area.ref))
      .sort((a, b) => b.ref.length - a.ref.length)[0];
    const nested = frameArea?.url ? classifyOrigin(frameArea.url, browser) : undefined;
    if (nested?.origin && origin?.origin && nested.origin !== origin.origin) source.warning = 'embedded-frame';
  }
  const texts = inScope.map((node) => textOf(node)).filter((text): text is string => !!text);
  const deviceCode = findDeviceCode(inScope, capped.some((control) => control.kind === 'text'));
  return {
    controls: capped,
    shown: deviceCode ? [] : ownerControls(capped),
    bindings,
    source,
    signature: signatureOf(source, capped),
    hasSecure,
    ...(topWeb?.url ? { url: topWeb.url } : {}),
    texts,
    ...(deviceCode ? { deviceCode } : {}),
  };
}

/**
 * Only what needs the owner: the text fields to type into, plus any error the
 * page shows about them. Buttons, pick lists and boxes stay with the agent, so
 * a step without a text field asks the owner for nothing.
 */
function ownerControls(controls: ScreenControl[]): InputHandoffControl[] {
  const shown = (control: ScreenControl): control is InputHandoffControl =>
    (control.kind === 'text' && control.contentType !== 'search') || (control.kind === 'note' && control.tone === 'error');
  // A search box alone (a page after sign-in) is not something the owner was asked for.
  if (!controls.some((control) => control.kind === 'text' && control.contentType !== 'search')) return [];
  return controls.filter(shown);
}

function controlIndexAfter(
  nodes: NativeAxNode[],
  controls: ScreenControl[],
  refs: Map<string, string>,
  nodeIndex: number,
): number {
  const order = new Map(nodes.map((node, index) => [node.ref, index]));
  for (let i = 0; i < controls.length; i++) {
    const ref = refs.get(controls[i].id);
    if (ref !== undefined && (order.get(ref) ?? -1) > nodeIndex) return i;
  }
  return controls.length;
}

/** Keep inputs and primary actions when a screen is crowded; links go first. */
function capControls(
  controls: ScreenControl[],
  bindings: Map<string, ControlBinding>,
): ScreenControl[] {
  if (controls.length <= INPUT_HANDOFF_MAX_CONTROLS) return controls;
  const rank = (control: ScreenControl) =>
    control.kind === 'text' || control.kind === 'choice' ? 0
      : control.kind === 'button' && control.primary ? 0
        : control.kind === 'note' && control.tone !== 'info' ? 1
          : control.kind === 'toggle' ? 1
            : control.kind === 'button' && !control.link ? 2
              : 3;
  const keep = new Set(
    controls
      .map((control, index) => ({ control, index }))
      .sort((a, b) => rank(a.control) - rank(b.control) || a.index - b.index)
      .slice(0, INPUT_HANDOFF_MAX_CONTROLS)
      .map((entry) => entry.control.id),
  );
  for (const control of controls) if (!keep.has(control.id)) bindings.delete(control.id);
  return controls.filter((control) => keep.has(control.id));
}
