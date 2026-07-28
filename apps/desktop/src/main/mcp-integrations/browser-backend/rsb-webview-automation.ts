import type {
  BrowserActRequest,
  BrowserControlRequest,
  BrowserElementQuery,
} from '@cindy/browser-control-runtime';
import type { WebContents } from 'electron';

interface AutomationLogger {
  warn(message: string, ...args: unknown[]): void;
}

interface DebuggerTransport {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, commandParams?: Record<string, unknown>): Promise<unknown>;
}

interface AxValue {
  value?: unknown;
}

interface RawAxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  childIds?: string[];
  backendDOMNodeId?: number;
}

interface SnapshotRef {
  role: string;
  name?: string;
  value?: string;
  backendDOMNodeId: number;
}

interface SnapshotTreeNode extends SnapshotRef {
  nodeId: string;
  children: number[];
  depth: number;
  ref?: string;
  url?: string;
}

interface ResolvedNode {
  objectId: string;
  backendDOMNodeId?: number;
}

export interface RsbSnapshotResult {
  format: 'ai' | 'aria';
  targetId: string;
  url: string;
  snapshot?: string;
  refs?: Record<string, SnapshotRef>;
  resources?: Array<{
    kind: string;
    url: string;
    label?: string;
  }>;
  barrier?: {
    kind: 'human-verification';
    evidence: string[];
  };
  nodes?: Array<{
    ref?: string;
    role: string;
    name?: string;
    value?: string;
    backendDOMNodeId: number;
  }>;
  stats: {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
  };
}

export interface RsbActResult {
  tabId: string;
  kind: BrowserActRequest['kind'];
  [key: string]: unknown;
}

export interface HumanVerificationBarrier {
  kind: 'human-verification';
  evidence: string[];
}

interface PageInspection {
  resources: Array<{ kind: string; url: string; label?: string }>;
  barrier?: HumanVerificationBarrier;
}

const INTERACTIVE_ROLES = new Set([
  'alertdialog',
  'button',
  'checkbox',
  'combobox',
  'gridcell',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'list',
  'none',
  'presentation',
  'rootwebarea',
]);

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 60_000;
const MAX_SNAPSHOT_REFS = 2_000;
const EFFICIENT_SNAPSHOT_MAX_CHARS = 8_000;
const EFFICIENT_SNAPSHOT_DEPTH = 6;

function axText(value: AxValue | undefined): string {
  const raw = value?.value;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : String(raw);
}

function finiteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} requires a non-negative finite number`);
  }
  return value;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function escapeSnapshotText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replace(/\s+/g, ' ').trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDebugger(wc: WebContents): DebuggerTransport {
  const candidate = (wc as unknown as { debugger?: DebuggerTransport }).debugger;
  if (!candidate) {
    throw new Error('webContents debugger is unavailable');
  }
  return candidate;
}

async function withDebugger<T>(
  wc: WebContents,
  body: (send: DebuggerTransport['sendCommand']) => Promise<T>,
): Promise<T> {
  const transport = getDebugger(wc);
  const alreadyAttached = transport.isAttached();
  if (!alreadyAttached) {
    transport.attach('1.3');
  }
  try {
    return await body(transport.sendCommand.bind(transport));
  } finally {
    if (!alreadyAttached && transport.isAttached()) {
      transport.detach();
    }
  }
}

function buildSnapshotTree(nodes: RawAxNode[]): { tree: SnapshotTreeNode[]; roots: number[] } {
  const tree: SnapshotTreeNode[] = [];
  const byId = new Map<string, number>();
  for (const raw of nodes) {
    const nodeId = raw.nodeId;
    const backendDOMNodeId = raw.backendDOMNodeId;
    if (
      raw.ignored === true ||
      typeof nodeId !== 'string' ||
      nodeId === '' ||
      typeof backendDOMNodeId !== 'number' ||
      backendDOMNodeId <= 0
    ) {
      continue;
    }
    byId.set(nodeId, tree.length);
    tree.push({
      nodeId,
      role: axText(raw.role).toLowerCase() || 'unknown',
      name: axText(raw.name) || undefined,
      value: axText(raw.value) || undefined,
      backendDOMNodeId,
      children: [],
      depth: 0,
    });
  }

  const rawById = new Map(
    nodes
      .filter((node): node is RawAxNode & { nodeId: string } => typeof node.nodeId === 'string')
      .map((node) => [node.nodeId, node]),
  );
  const childIndexes = new Set<number>();
  const visibleChildren = (rawId: string, seen = new Set<string>()): number[] => {
    if (seen.has(rawId)) return [];
    seen.add(rawId);
    const raw = rawById.get(rawId);
    const result: number[] = [];
    for (const childId of raw?.childIds ?? []) {
      const childIndex = byId.get(childId);
      if (childIndex !== undefined) {
        result.push(childIndex);
      } else {
        result.push(...visibleChildren(childId, new Set(seen)));
      }
    }
    return result;
  };
  for (let index = 0; index < tree.length; index += 1) {
    tree[index].children = visibleChildren(tree[index].nodeId);
    for (const childIndex of tree[index].children) childIndexes.add(childIndex);
  }

  const roots = tree.map((_node, index) => index).filter((index) => !childIndexes.has(index));
  const stack = (roots.length > 0 ? roots : tree.length > 0 ? [0] : []).map((index) => ({
    index,
    depth: 0,
  }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const node = tree[current.index];
    node.depth = current.depth;
    for (const child of node.children.toReversed()) {
      stack.push({ index: child, depth: current.depth + 1 });
    }
  }
  return { tree, roots };
}

function shouldReference(node: SnapshotTreeNode): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  return Boolean(node.name) && !STRUCTURAL_ROLES.has(node.role);
}

function shouldRender(node: SnapshotTreeNode, req: BrowserControlRequest): boolean {
  if (typeof req.depth === 'number' && node.depth > req.depth) return false;
  if (req.interactive === true) return INTERACTIVE_ROLES.has(node.role);
  if (req.compact === true && STRUCTURAL_ROLES.has(node.role) && !node.name && !node.ref) {
    return false;
  }
  return true;
}

function renderSnapshotTree(
  tree: SnapshotTreeNode[],
  roots: number[],
  req: BrowserControlRequest,
): string[] {
  const lines: string[] = [];
  const visit = (index: number): void => {
    const node = tree[index];
    if (!node) return;
    if (shouldRender(node, req)) {
      const name = node.name ? ` "${escapeSnapshotText(node.name)}"` : '';
      const ref = node.ref ? ` [ref=${node.ref}]` : '';
      const value = node.value ? ` value="${escapeSnapshotText(node.value)}"` : '';
      const url = node.url ? ` [url=${node.url}]` : '';
      lines.push(`${'  '.repeat(node.depth)}- ${node.role}${name}${ref}${value}${url}`);
    }
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return lines;
}

function truncateSnapshotLines(lines: string[], maxChars: number | undefined): string[] {
  // The shared browser contract uses zero as the explicit "no limit" value.
  if (maxChars === undefined || maxChars === 0) return lines;
  if (maxChars <= 0) return [];
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const added = line.length + (out.length > 0 ? 1 : 0);
    if (used + added > maxChars) break;
    out.push(line);
    used += added;
  }
  return out;
}

function visibleRefs(
  refs: Record<string, SnapshotRef>,
  lines: string[],
): Record<string, SnapshotRef> {
  const rendered = lines.join('\n');
  return Object.fromEntries(
    Object.entries(refs).filter(([ref]) => rendered.includes(`[ref=${ref}]`)),
  );
}

async function resolveHref(
  send: DebuggerTransport['sendCommand'],
  backendDOMNodeId: number,
): Promise<string | undefined> {
  const resolved = (await send('DOM.resolveNode', { backendNodeId: backendDOMNodeId })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) return undefined;
  try {
    const result = (await send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function() { return typeof this.href === "string" ? this.href : ""; }',
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    return typeof result.result?.value === 'string' && result.result.value !== ''
      ? result.result.value
      : undefined;
  } finally {
    await releaseObject(send, objectId);
  }
}

async function releaseObject(
  send: DebuggerTransport['sendCommand'],
  objectId: string | undefined,
): Promise<void> {
  if (!objectId) return;
  await send('Runtime.releaseObject', { objectId }).catch(() => undefined);
}

async function inspectPage(
  send: DebuggerTransport['sendCommand'],
  includeResources: boolean,
): Promise<PageInspection> {
  const evaluated = (await send('Runtime.evaluate', {
    expression: `(() => {
      const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const pageText = normalize(document.body?.innerText || "").slice(0, 6000);
      const title = normalize(document.title);
      const evidence = [];
      const titleMatch = /(verify you are human|checking your browser|just a moment|unusual traffic|captcha|人机验证|安全验证|访问验证)/i.test(title);
      if (titleMatch) {
        evidence.push("page title indicates manual verification");
      }
      const challengeSelector = [
        '[data-sitekey]',
        'iframe[src*="captcha" i]',
        'iframe[src*="challenge" i]',
        '[id*="captcha" i]',
        '[class*="captcha" i]',
      ].join(",");
      const verificationControl = [...document.querySelectorAll(challengeSelector)].find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width >= 20 && rect.height >= 20 && style.visibility !== "hidden" && style.display !== "none";
      });
      if (verificationControl) {
        evidence.push("page contains a verification control");
      }
      const textMatch = /(verify you are human|checking your browser|unusual traffic|complete the security check|i['’]?m not a robot|人机验证|安全验证|访问验证)/i.test(pageText);
      if (textMatch) {
        evidence.push("page text asks for a manual check");
      }
      const verificationBlocked = titleMatch || Boolean(verificationControl && textMatch);

      const resources = [];
      if (${JSON.stringify(includeResources)}) {
        const seen = new Set();
        const add = (kind, raw, label) => {
          if (resources.length >= 200) return;
          let url;
          try {
            url = new URL(String(raw || ""), document.baseURI);
          } catch {
            return;
          }
          if (!["http:", "https:"].includes(url.protocol)) return;
          const href = url.href;
          if (seen.has(href)) return;
          seen.add(href);
          const item = { kind, url: href };
          const text = normalize(label);
          if (text) item.label = text.slice(0, 200);
          resources.push(item);
        };
        document.querySelectorAll('img[src],video[src],audio[src],source[src],a[download][href],link[rel~="stylesheet"][href],link[rel~="icon"][href],link[rel="manifest"][href]').forEach((element) => {
          const tag = element.tagName.toLowerCase();
          const rel = normalize(element.getAttribute("rel")).toLowerCase();
          const kind = tag === "img"
            ? "image"
            : tag === "video" || tag === "source" && element.parentElement?.tagName.toLowerCase() === "video"
              ? "video"
              : tag === "audio" || tag === "source" && element.parentElement?.tagName.toLowerCase() === "audio"
                ? "audio"
                : tag === "a"
                  ? "download"
                  : rel.includes("stylesheet")
                    ? "stylesheet"
                    : "link";
          add(kind, element.getAttribute("src") || element.getAttribute("href"), element.getAttribute("alt") || element.getAttribute("download") || element.getAttribute("title"));
        });
      }
      return {
        resources,
        ...(verificationBlocked ? { barrier: { kind: "human-verification", evidence: [...new Set(evidence)] } } : {}),
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
  if (evaluated.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.text ?? 'page inspection failed');
  }
  const value = evaluated.result?.value;
  if (!value || typeof value !== 'object') return { resources: [] };
  const raw = value as {
    resources?: unknown;
    barrier?: { kind?: unknown; evidence?: unknown };
  };
  const resources: PageInspection['resources'] = [];
  if (Array.isArray(raw.resources)) {
    for (const entry of raw.resources.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as { kind?: unknown; url?: unknown; label?: unknown };
      if (typeof item.kind !== 'string' || typeof item.url !== 'string') continue;
      if (item.url.length > 4096) continue;
      try {
        const parsed = new URL(item.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        if (parsed.username || parsed.password) continue;
      } catch {
        continue;
      }
      resources.push({
        kind: item.kind.slice(0, 32),
        url: item.url,
        ...(typeof item.label === 'string' && item.label !== ''
          ? { label: item.label.slice(0, 200) }
          : {}),
      });
    }
  }
  const evidence = Array.isArray(raw.barrier?.evidence)
    ? raw.barrier.evidence.filter((item): item is string => typeof item === 'string').slice(0, 8)
    : [];
  return {
    resources,
    ...(evidence.length > 0 ? { barrier: { kind: 'human-verification', evidence } } : {}),
  };
}

async function resolveSelector(
  send: DebuggerTransport['sendCommand'],
  selector: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  options?: { allowHidden?: boolean },
): Promise<ResolvedNode> {
  return resolveElementQuery(send, { css: selector }, timeoutMs, options);
}

async function resolveFrameRoot(
  send: DebuggerTransport['sendCommand'],
  selector: string,
  timeoutMs?: number,
): Promise<{ frameId: string; nodeId?: number }> {
  const frame = await resolveSelector(send, selector, timeoutMs);
  try {
    const described = (await send('DOM.describeNode', {
      backendNodeId: frame.backendDOMNodeId,
      depth: 1,
    })) as {
      node?: {
        frameId?: string;
        contentDocument?: { frameId?: string; nodeId?: number };
      };
    };
    const frameId = described.node?.contentDocument?.frameId ?? described.node?.frameId;
    if (!frameId) throw new Error(`frame selector did not resolve to an iframe: ${selector}`);
    return {
      frameId,
      ...(described.node?.contentDocument?.nodeId
        ? { nodeId: described.node.contentDocument.nodeId }
        : {}),
    };
  } finally {
    await releaseObject(send, frame.objectId);
  }
}

async function resolveSelectorInFrame(
  send: DebuggerTransport['sendCommand'],
  frameNodeId: number,
  selector: string,
): Promise<ResolvedNode> {
  const queried = (await send('DOM.querySelector', {
    nodeId: frameNodeId,
    selector,
  })) as { nodeId?: number };
  if (!queried.nodeId) throw new Error(`selector not found in frame: ${selector}`);
  const described = (await send('DOM.describeNode', {
    nodeId: queried.nodeId,
  })) as { node?: { backendNodeId?: number } };
  if (!described.node?.backendNodeId) {
    throw new Error(`selector could not be resolved in frame: ${selector}`);
  }
  return {
    objectId: '',
    backendDOMNodeId: described.node.backendNodeId,
  };
}

async function resolveElementQuery(
  send: DebuggerTransport['sendCommand'],
  query: BrowserElementQuery,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  options?: { allowHidden?: boolean },
): Promise<ResolvedNode> {
  if (query.index !== undefined && (!Number.isInteger(query.index) || query.index < 0)) {
    throw new Error('element query index must be a non-negative integer');
  }
  const hasLookupField = [
    query.css,
    query.role,
    query.name,
    query.text,
    query.label,
    query.placeholder,
    query.testId,
  ].some((value) => typeof value === 'string' && value !== '');
  if (!hasLookupField) {
    throw new Error('element query requires at least one field');
  }
  const boundedTimeout = positiveInt(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
  const allowHidden = options?.allowHidden === true;
  const evaluated = (await send('Runtime.evaluate', {
    expression: `(() => {
      const query = ${JSON.stringify(query)};
      const deadline = Date.now() + ${boundedTimeout};
      const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const equals = (actual, expected) => {
        const left = normalize(actual);
        const right = normalize(expected);
        return query.exact === true ? left === right : left.toLowerCase().includes(right.toLowerCase());
      };
      const implicitRole = (element) => {
        const explicit = element.getAttribute("role");
        if (explicit) return explicit.toLowerCase();
        const tag = element.tagName.toLowerCase();
        if (tag === "article") return "article";
        if (tag === "aside") return "complementary";
        if (tag === "header") return element.closest("article,aside,main,nav,section") ? "generic" : "banner";
        if (tag === "footer") return element.closest("article,aside,main,nav,section") ? "generic" : "contentinfo";
        if (tag === "form") return "form";
        if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") return "heading";
        if (tag === "img") return element.getAttribute("alt") === "" ? "presentation" : "img";
        if (tag === "main") return "main";
        if (tag === "nav") return "navigation";
        if (tag === "section") return element.getAttribute("aria-label") ? "region" : "generic";
        if (tag === "table") return "table";
        if (tag === "tr") return "row";
        if (tag === "td" || tag === "th") return element.tagName === "TH" ? "columnheader" : "cell";
        if (tag === "li") return "listitem";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "output") return "status";
        if (tag === "button") return "button";
        if (tag === "a" && element.hasAttribute("href")) return "link";
        if (tag === "select") return element.multiple ? "listbox" : "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "option") return "option";
        if (tag === "input") {
          const type = String(element.type || "text").toLowerCase();
          if (["button", "submit", "reset", "image"].includes(type)) return "button";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (type === "range") return "slider";
          if (type === "number") return "spinbutton";
          if (type === "search") return "searchbox";
          if (!["hidden", "file"].includes(type)) return "textbox";
        }
        return "";
      };
      const labelText = (element) => {
        if (element.labels?.length) {
          return Array.from(element.labels).map((label) => label.textContent || "").join(" ");
        }
        const id = element.getAttribute("id");
        if (id) {
          const escaped = globalThis.CSS?.escape ? CSS.escape(id) : id.replace(/["\\\\]/g, "\\\\$&");
          const label = document.querySelector('label[for="' + escaped + '"]');
          if (label) return label.textContent || "";
        }
        return element.closest("label")?.textContent || "";
      };
      const accessibleName = (element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
          const text = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ");
          if (normalize(text)) return text;
        }
        return element.getAttribute("aria-label")
          || labelText(element)
          || element.getAttribute("alt")
          || element.getAttribute("title")
          || (element instanceof HTMLInputElement ? element.value : "")
          || element.textContent
          || "";
      };
      const visible = (element) => {
        if (!element.isConnected) return false;
        if (${JSON.stringify(allowHidden)} && element instanceof HTMLInputElement && element.type === "file") {
          return !element.disabled && element.getAttribute("aria-disabled") !== "true";
        }
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const matches = (element) => {
        if (query.role && implicitRole(element) !== String(query.role).toLowerCase()) return false;
        if (query.name && !equals(accessibleName(element), query.name)) return false;
        if (query.text && !equals(element.textContent, query.text)) return false;
        if (query.label && !equals(labelText(element), query.label)) return false;
        if (query.placeholder && !equals(element.getAttribute("placeholder"), query.placeholder)) return false;
        if (query.testId && element.getAttribute("data-testid") !== query.testId) return false;
        return visible(element);
      };
      return new Promise((resolve, reject) => {
        const poll = () => {
          let candidates;
          try {
            candidates = Array.from(document.querySelectorAll(query.css || "*")).filter(matches);
            const hasNarrowingField = Boolean(
              query.css || query.role || query.name || query.label || query.placeholder || query.testId
            );
            if (query.text && !hasNarrowingField) {
              candidates = candidates.filter((element) => (
                !Array.from(element.children).some((child) => (
                  visible(child) && equals(child.textContent, query.text)
                ))
              ));
            }
          } catch (error) {
            reject(error);
            return;
          }
          const index = Number.isInteger(query.index) ? query.index : null;
          if (index !== null && candidates[index]) {
            resolve(candidates[index]);
            return;
          }
          if (index === null && candidates.length === 1) {
            resolve(candidates[0]);
            return;
          }
          if (index === null && candidates.length > 1) {
            reject(new Error("element query matched " + candidates.length + " elements; provide index"));
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("element query timed out"));
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
    })()`,
    awaitPromise: true,
    returnByValue: false,
    timeout: boundedTimeout + 1_000,
  })) as {
    result?: { objectId?: string; subtype?: string };
    exceptionDetails?: {
      text?: string;
      exception?: { description?: string; value?: unknown };
    };
  };
  if (evaluated.exceptionDetails) {
    const details = evaluated.exceptionDetails;
    const message =
      details.exception?.description ??
      (typeof details.exception?.value === 'string' ? details.exception.value : undefined) ??
      details.text ??
      'element query failed';
    throw new Error(message);
  }
  const objectId = evaluated.result?.objectId;
  if (!objectId || evaluated.result?.subtype === 'null') {
    throw new Error('element query did not resolve to an element');
  }
  const described = (await send('DOM.describeNode', { objectId })) as {
    node?: { backendNodeId?: number };
  };
  return { objectId, backendDOMNodeId: described.node?.backendNodeId };
}

async function resolveRef(
  send: DebuggerTransport['sendCommand'],
  target: SnapshotRef,
): Promise<ResolvedNode> {
  const resolved = (await send('DOM.resolveNode', {
    backendNodeId: target.backendDOMNodeId,
  })) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (!objectId) {
    throw new Error('snapshot ref is stale; take a new snapshot');
  }
  return { objectId, backendDOMNodeId: target.backendDOMNodeId };
}

async function callOnNode<T>(
  send: DebuggerTransport['sendCommand'],
  objectId: string,
  functionDeclaration: string,
  args?: unknown[],
): Promise<T> {
  const result = (await send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args?.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'page script failed',
    );
  }
  return result.result?.value as T;
}

async function withReleasedNode<T>(
  send: DebuggerTransport['sendCommand'],
  resolve: () => Promise<ResolvedNode>,
  body: (node: ResolvedNode) => Promise<T>,
): Promise<T> {
  const node = await resolve();
  try {
    return await body(node);
  } finally {
    await releaseObject(send, node.objectId);
  }
}

async function fillNode(
  send: DebuggerTransport['sendCommand'],
  target: ResolvedNode,
  value: unknown,
  declaredType?: string,
): Promise<void> {
  await callOnNode(
    send,
    target.objectId,
    `function(value, declaredType) {
      const type = String(declaredType || (
        this instanceof HTMLInputElement ? this.type : ""
      )).toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (!(this instanceof HTMLInputElement)) {
          throw new Error("checkbox/radio fill target is not an input");
        }
        const checked = value === true || value === 1 || value === "1" || value === "true";
        if (this.checked !== checked) {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "checked",
          )?.set;
          if (setter) setter.call(this, checked);
          else this.checked = checked;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      const text = value === undefined || value === null ? "" : String(value);
      if (this instanceof HTMLSelectElement) {
        const selected = Array.from(this.options).find((option) => (
          option.value === text || option.label === text
        ));
        if (!selected) throw new Error("select option not found");
        this.value = selected.value;
      } else if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(this),
          "value",
        )?.set;
        if (setter) setter.call(this, text);
        else this.value = text;
      } else if (this instanceof HTMLElement && this.isContentEditable) {
        this.textContent = text;
      } else {
        throw new Error("fill target is not editable");
      }
      this.dispatchEvent(new Event("input", { bubbles: true }));
      this.dispatchEvent(new Event("change", { bubbles: true }));
    }`,
    [value, declaredType],
  );
}

async function focusNode(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
  requireEditable = false,
): Promise<void> {
  const result = await callOnNode<{ ok: boolean; reason?: string }>(
    send,
    node.objectId,
    `function(requireEditable) {
      if (!(this instanceof HTMLElement) && !(this instanceof SVGElement)) {
        return { ok: false, reason: "target is not an element" };
      }
      if ("disabled" in this && this.disabled) {
        return { ok: false, reason: "target is disabled" };
      }
      if (requireEditable && "readOnly" in this && this.readOnly) {
        return { ok: false, reason: "target is read-only" };
      }
      if (requireEditable) {
        const textInput = this instanceof HTMLInputElement
          && [
            "date", "datetime-local", "email", "month", "number", "password",
            "search", "tel", "text", "time", "url", "week",
          ].includes(this.type);
        const editable = textInput
          || this instanceof HTMLTextAreaElement
          || (this instanceof HTMLElement && this.isContentEditable);
        if (!editable) return { ok: false, reason: "target is not editable" };
      }
      this.scrollIntoView({ block: "center", inline: "center" });
      if (typeof this.focus === "function") this.focus();
      return { ok: true };
    }`,
    [requireEditable],
  );
  if (!result?.ok) throw new Error(result?.reason ?? 'unable to focus target');
}

async function selectEditableContents(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
): Promise<void> {
  await callOnNode(
    send,
    node.objectId,
    `function() {
      if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
        this.select();
        return;
      }
      if (this instanceof HTMLElement && this.isContentEditable) {
        const selection = this.ownerDocument.defaultView?.getSelection();
        const range = this.ownerDocument.createRange();
        range.selectNodeContents(this);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }`,
  );
}

async function waitForActionable(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
  options: { editable?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
  const result = await callOnNode<{ ok: boolean; reason?: string }>(
    send,
    node.objectId,
    `function(options) {
      const deadline = Date.now() + options.timeoutMs;
      const inspect = () => {
        if (!(this instanceof Element) || !this.isConnected) return "target is detached";
        const style = getComputedStyle(this);
        const rect = this.getBoundingClientRect();
        if (
          style.display === "none"
          || style.visibility === "hidden"
          || style.visibility === "collapse"
          || rect.width <= 0
          || rect.height <= 0
        ) return "target is not visible";
        if (("disabled" in this && this.disabled) || this.getAttribute("aria-disabled") === "true") {
          return "target is disabled";
        }
        if (options.editable) {
          if ("readOnly" in this && this.readOnly) return "target is read-only";
          const textInput = this instanceof HTMLInputElement
            && [
              "date", "datetime-local", "email", "month", "number", "password",
              "search", "tel", "text", "time", "url", "week",
            ].includes(this.type);
          const editable = textInput
            || this instanceof HTMLTextAreaElement
            || (this instanceof HTMLElement && this.isContentEditable);
          if (!editable) return "target is not editable";
        }
        return "";
      };
      return new Promise((resolve) => {
        const poll = () => {
          const reason = inspect();
          if (!reason) {
            this.scrollIntoView({ block: "center", inline: "center" });
            resolve({ ok: true });
            return;
          }
          if (Date.now() >= deadline) {
            resolve({ ok: false, reason });
            return;
          }
          setTimeout(poll, 100);
        };
        poll();
      });
    }`,
    [{ editable: options.editable === true, timeoutMs }],
  );
  if (!result?.ok) throw new Error(result?.reason ?? 'target is not actionable');
}

let actionTicketSequence = 0;

async function stampActionTarget(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
): Promise<string> {
  actionTicketSequence += 1;
  const ticket = `rsb-${Date.now().toString(36)}-${actionTicketSequence.toString(36)}`;
  await callOnNode(
    send,
    node.objectId,
    `function(ticket) {
      Reflect.set(this, Symbol.for("cindy.rsb.action-target"), ticket);
      return true;
    }`,
    [ticket],
  );
  return ticket;
}

async function centerOfNode(
  send: DebuggerTransport['sendCommand'],
  node: ResolvedNode,
  options: { focus?: boolean } = {},
): Promise<{ x: number; y: number }> {
  if (options.focus !== false) await focusNode(send, node);
  const box = (await send('DOM.getBoxModel', {
    ...(node.backendDOMNodeId
      ? { backendNodeId: node.backendDOMNodeId }
      : { objectId: node.objectId }),
  })) as { model?: { content?: number[]; border?: number[] } };
  const quad = box.model?.content ?? box.model?.border;
  if (!quad || quad.length < 8) throw new Error('target has no visible box');
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined || value === 'left') return 'left';
  if (value === 'right' || value === 'middle') return value;
  throw new Error('button must be left, right, or middle');
}

function modifierMask(modifiers: unknown): number {
  if (!Array.isArray(modifiers)) return 0;
  let mask = 0;
  for (const raw of modifiers) {
    if (typeof raw !== 'string') continue;
    switch (raw.toLowerCase()) {
      case 'alt':
        mask |= 1;
        break;
      case 'control':
      case 'ctrl':
        mask |= 2;
        break;
      case 'meta':
      case 'command':
      case 'cmd':
        mask |= 4;
        break;
      case 'controlormeta':
        mask |= process.platform === 'darwin' ? 4 : 2;
        break;
      case 'shift':
        mask |= 8;
        break;
    }
  }
  return mask;
}

type TranslatedInputMethod =
  'Input.dispatchKeyEvent' | 'Input.dispatchMouseEvent' | 'Input.insertText';

interface TranslatedInputCommand {
  method: TranslatedInputMethod;
  params: Record<string, unknown>;
  targetTicket?: string;
}

interface TranslatedInputResult {
  ok: boolean;
  error?: string;
}

type InputDispatcher = (
  method: TranslatedInputMethod,
  params: Record<string, unknown>,
  targetTicket?: string,
) => Promise<void>;

type NativeKeyDispatcher = (
  type: 'keyDown' | 'keyUp',
  keyCode: string,
  modifiers: string[],
) => Promise<void>;

/**
 * Runs inside the guest page, not in Electron Main.
 *
 * An embedded guest and Cindy's composer can disagree about which renderer
 * owns native input focus. Dispatching equivalent DOM events inside the guest
 * keeps browser actions scoped to the tab that supplied the element reference.
 * Keep this function self-contained so `toString()` can safely serialize it.
 */
function translateInputCommand(command: TranslatedInputCommand): TranslatedInputResult {
  const params = command.params;
  const numberParam = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name} must be a finite number`);
    }
    return value;
  };
  const stringParam = (value: unknown, name: string): string => {
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
  };
  const eventWindow = (element: Element): Window & typeof globalThis =>
    element.ownerDocument.defaultView ?? window;
  const modifiers = (
    mask: number,
  ): Pick<KeyboardEventInit, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> => {
    const enabled = (value: number): boolean => Math.floor(mask / value) % 2 === 1;
    return {
      altKey: enabled(1),
      ctrlKey: enabled(2),
      metaKey: enabled(4),
      shiftKey: enabled(8),
    };
  };
  const mouseButton = (button: unknown): number => {
    switch (button) {
      case undefined:
      case 'none':
      case 'left':
        return 0;
      case 'middle':
        return 1;
      case 'right':
        return 2;
      case 'back':
        return 3;
      case 'forward':
        return 4;
      default:
        throw new Error(`unsupported mouse button: ${String(button)}`);
    }
  };
  const carriesTicket = (element: Element | null): boolean => {
    if (!command.targetTicket) return true;
    let current = element;
    while (current) {
      const currentWindow = current.ownerDocument.defaultView ?? window;
      const symbol = currentWindow.Symbol.for('cindy.rsb.action-target');
      if (Reflect.get(current, symbol) === command.targetTicket) return true;
      const root = current.getRootNode();
      current =
        current.parentElement ?? (root instanceof currentWindow.ShadowRoot ? root.host : null);
    }
    return false;
  };
  const requireTicket = (element: Element | null): void => {
    if (!carriesTicket(element)) {
      throw new Error('page changed the action target before input was dispatched');
    }
  };
  const pointTarget = (
    root: Document | ShadowRoot,
    x: number,
    y: number,
  ): { target: Element; x: number; y: number } | null => {
    const rootWindow =
      ('defaultView' in root ? root.defaultView : root.ownerDocument.defaultView) ?? window;
    const target = root.elementFromPoint(x, y);
    if (!(target instanceof rootWindow.Element)) return null;
    if (target.shadowRoot) {
      const nested = target.shadowRoot.elementFromPoint(x, y);
      if (nested instanceof rootWindow.Element) return { target: nested, x, y };
    }
    if (target instanceof rootWindow.HTMLIFrameElement) {
      try {
        const frameDocument = target.contentDocument;
        if (frameDocument) {
          const bounds = target.getBoundingClientRect();
          return pointTarget(frameDocument, x - bounds.left, y - bounds.top) ?? { target, x, y };
        }
      } catch {
        throw new Error('cross-origin iframe input is not supported');
      }
    }
    return { target, x, y };
  };
  const dispatchMouse = (target: Element, type: string, init: MouseEventInit): boolean =>
    target.dispatchEvent(new (eventWindow(target).MouseEvent)(type, init));
  const mouseInit = (target: Element, x: number, y: number): MouseEventInit => ({
    ...modifiers(Number(params.modifiers ?? 0)),
    bubbles: true,
    button: mouseButton(params.button),
    buttons: Number(params.buttons ?? 0),
    cancelable: true,
    clientX: x,
    clientY: y,
    composed: true,
    detail: Number(params.clickCount ?? 0),
    screenX: x,
    screenY: y,
    view: eventWindow(target),
  });
  const isFocusable = (element: Element): element is HTMLElement => {
    if (!(element instanceof eventWindow(element).HTMLElement)) return false;
    if (element.isContentEditable || element.tabIndex >= 0) return true;
    if (element.tagName === 'A') return element.hasAttribute('href');
    return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName);
  };
  const focusMouseTarget = (target: Element): void => {
    let focusTarget: HTMLElement | null = null;
    if (target instanceof eventWindow(target).HTMLLabelElement && target.control) {
      focusTarget = target.control;
    } else {
      for (let current: Element | null = target; current; current = current.parentElement) {
        if (isFocusable(current)) {
          focusTarget = current;
          break;
        }
      }
    }
    if (!focusTarget) return;
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      focusTarget.focus();
    }
  };
  const stateRoot = globalThis as typeof globalThis & {
    __cindyRsbInputTranslationState?: {
      mousePress?: { button: unknown; moved: boolean; x: number; y: number } | null;
    };
  };
  const state = (stateRoot.__cindyRsbInputTranslationState ??= {});
  const translateMouse = (): void => {
    const type = stringParam(params.type, 'type');
    const screenX = numberParam(params.x, 'x');
    const screenY = numberParam(params.y, 'y');
    const resolved = pointTarget(document, screenX, screenY);
    if (!resolved) throw new Error(`no element found at point ${screenX},${screenY}`);
    const { target, x, y } = resolved;
    requireTicket(target);
    const init = mouseInit(target, x, y);
    if (type === 'mouseMoved') {
      if (Number(params.buttons ?? 0) !== 0 && state.mousePress) {
        state.mousePress.moved = true;
      }
      dispatchMouse(target, 'pointermove', init);
      dispatchMouse(target, 'mousemove', init);
      return;
    }
    if (type === 'mousePressed') {
      state.mousePress = {
        button: params.button ?? 'left',
        moved: false,
        x: screenX,
        y: screenY,
      };
      const pointerAllowed = dispatchMouse(target, 'pointerdown', init);
      const mouseAllowed = dispatchMouse(target, 'mousedown', init);
      if (pointerAllowed && mouseAllowed) focusMouseTarget(target);
      return;
    }
    if (type === 'mouseReleased') {
      dispatchMouse(target, 'pointerup', init);
      dispatchMouse(target, 'mouseup', init);
      const pressed = state.mousePress;
      state.mousePress = null;
      if (
        !pressed ||
        pressed.moved ||
        pressed.button !== (params.button ?? 'left') ||
        Math.abs(pressed.x - screenX) > 1 ||
        Math.abs(pressed.y - screenY) > 1
      ) {
        return;
      }
      if (params.button === 'right') {
        dispatchMouse(target, 'contextmenu', init);
        return;
      }
      if (params.button === 'middle') {
        dispatchMouse(target, 'auxclick', init);
        return;
      }
      dispatchMouse(target, 'click', init);
      if (Number(params.clickCount ?? 0) >= 2) {
        dispatchMouse(target, 'dblclick', init);
      }
      return;
    }
    throw new Error(`unsupported mouse event type: ${type}`);
  };
  const deepestActiveElement = (root: Document | ShadowRoot): Element | null => {
    const active = root.activeElement;
    if (!active) return null;
    if (active instanceof eventWindow(active).HTMLIFrameElement) {
      try {
        const frameDocument = active.contentDocument;
        if (frameDocument) return deepestActiveElement(frameDocument) ?? active;
      } catch {
        throw new Error('cross-origin iframe input is not supported');
      }
    }
    return active.shadowRoot ? (deepestActiveElement(active.shadowRoot) ?? active) : active;
  };
  const isDirectTextControl = (
    element: Element,
  ): element is HTMLInputElement | HTMLTextAreaElement => {
    const view = eventWindow(element);
    if (element instanceof view.HTMLTextAreaElement) return true;
    return (
      element instanceof view.HTMLInputElement &&
      ['password', 'search', 'tel', 'text', 'url'].includes(element.type)
    );
  };
  const isStructuredValueControl = (element: Element): element is HTMLInputElement =>
    element instanceof eventWindow(element).HTMLInputElement &&
    ['date', 'datetime-local', 'month', 'time', 'week'].includes(element.type);
  const isValueTextControl = (element: Element): element is HTMLInputElement =>
    element instanceof eventWindow(element).HTMLInputElement &&
    (['email', 'number'].includes(element.type) || isStructuredValueControl(element));
  const isContentEditable = (element: Element): element is HTMLElement =>
    element instanceof eventWindow(element).HTMLElement && element.isContentEditable;
  const editableElement = (): Element | null => {
    const active = deepestActiveElement(document);
    return active &&
      (isDirectTextControl(active) || isValueTextControl(active) || isContentEditable(active))
      ? active
      : null;
  };
  const createInputEvent = (element: Element, type: string, init: InputEventInit): Event => {
    const view = eventWindow(element);
    return typeof view.InputEvent === 'function'
      ? new view.InputEvent(type, init)
      : new view.Event(type, {
          bubbles: init.bubbles,
          cancelable: init.cancelable,
          composed: init.composed,
        });
  };
  const insertText = (element: Element | null, text: string, inputType = 'insertText'): void => {
    if (!element) throw new Error('no editable element is focused');
    const beforeInput = createInputEvent(element, 'beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: text,
      inputType,
    });
    if (!element.dispatchEvent(beforeInput)) return;
    if (isDirectTextControl(element)) {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      element.setRangeText(text, start, end, 'end');
    } else if (isStructuredValueControl(element)) {
      element.value = text;
    } else if (isValueTextControl(element)) {
      if (element.ownerDocument.execCommand?.('insertText', false, text)) return;
      element.value += text;
    } else if (isContentEditable(element)) {
      const selection = eventWindow(element).getSelection();
      let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || !element.contains(range.commonAncestorContainer)) {
        range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
      }
      range.deleteContents();
      const node = element.ownerDocument.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      throw new Error('focused element is not editable');
    }
    element.dispatchEvent(
      createInputEvent(element, 'input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: text,
        inputType,
      }),
    );
  };
  const deleteText = (element: Element | null, direction: 'backward' | 'forward'): void => {
    if (!element) return;
    const inputType = direction === 'forward' ? 'deleteContentForward' : 'deleteContentBackward';
    const beforeInput = createInputEvent(element, 'beforeinput', {
      bubbles: true,
      cancelable: true,
      composed: true,
      data: null,
      inputType,
    });
    if (!element.dispatchEvent(beforeInput)) return;
    if (isDirectTextControl(element)) {
      const value = element.value;
      let start = element.selectionStart ?? value.length;
      let end = element.selectionEnd ?? value.length;
      if (start === end) {
        if (direction === 'forward') end = Math.min(value.length, end + 1);
        else start = Math.max(0, start - 1);
      }
      element.setRangeText('', start, end, 'end');
    } else if (isValueTextControl(element)) {
      if (element.ownerDocument.execCommand?.(direction === 'forward' ? 'forwardDelete' : 'delete'))
        return;
      if (direction === 'backward') element.value = element.value.slice(0, -1);
    } else {
      return;
    }
    element.dispatchEvent(
      createInputEvent(element, 'input', {
        bubbles: true,
        cancelable: false,
        composed: true,
        data: null,
        inputType,
      }),
    );
  };
  const keyCode = (key: string): number => {
    const known: Record<string, number> = {
      Backspace: 8,
      Tab: 9,
      Enter: 13,
      Escape: 27,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
      Delete: 46,
    };
    return known[key] ?? (key.length === 1 ? (key.toUpperCase().codePointAt(0) ?? 0) : 0);
  };
  const translateKey = (): void => {
    const type = stringParam(params.type, 'type');
    const key = stringParam(params.key, 'key');
    const target = deepestActiveElement(document) ?? document.body ?? document.documentElement;
    requireTicket(target);
    if (type === 'validate') return;
    const code = keyCode(key);
    const init: KeyboardEventInit & { keyCode: number; which: number } = {
      ...modifiers(Number(params.modifiers ?? 0)),
      bubbles: true,
      cancelable: true,
      code: typeof params.code === 'string' ? params.code : '',
      composed: true,
      key,
      keyCode: code,
      which: code,
    };
    const makeKeyboardEvent = (eventType: string): KeyboardEvent => {
      const event = new (eventWindow(target).KeyboardEvent)(eventType, init);
      for (const [name, value] of [
        ['keyCode', code],
        ['which', code],
        ['charCode', eventType === 'keypress' ? code : 0],
      ] as const) {
        try {
          Object.defineProperty(event, name, { get: () => value });
        } catch {
          // Older Chromium builds may expose these properties as non-configurable.
        }
      }
      return event;
    };
    if (type === 'keyUp') {
      target.dispatchEvent(makeKeyboardEvent('keyup'));
      return;
    }
    if (type !== 'keyDown' && type !== 'rawKeyDown' && type !== 'char') {
      throw new Error(`unsupported key event type: ${type}`);
    }
    if (type !== 'char' && !target.dispatchEvent(makeKeyboardEvent('keydown'))) return;
    const text = typeof params.text === 'string' ? params.text : '';
    if (text) {
      if (target.dispatchEvent(makeKeyboardEvent('keypress'))) {
        insertText(editableElement(), text);
      }
      return;
    }
    const activeEditable = editableElement();
    if (key === 'Backspace') deleteText(activeEditable, 'backward');
    else if (key === 'Delete') deleteText(activeEditable, 'forward');
    else if (key === 'Enter') {
      if (
        activeEditable &&
        (activeEditable instanceof eventWindow(activeEditable).HTMLTextAreaElement ||
          isContentEditable(activeEditable))
      ) {
        insertText(activeEditable, '\n', 'insertLineBreak');
      } else if (
        activeEditable &&
        activeEditable instanceof eventWindow(activeEditable).HTMLInputElement
      ) {
        activeEditable.form?.requestSubmit();
      }
    }
  };
  try {
    switch (command.method) {
      case 'Input.dispatchMouseEvent':
        translateMouse();
        break;
      case 'Input.dispatchKeyEvent':
        translateKey();
        break;
      case 'Input.insertText':
        {
          const target = editableElement();
          requireTicket(target);
          insertText(target, stringParam(params.text, 'text'));
        }
        break;
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatchTranslatedInput(
  wc: WebContents,
  method: TranslatedInputMethod,
  params: Record<string, unknown>,
  targetTicket?: string,
): Promise<void> {
  const source = `(${translateInputCommand.toString()})(${JSON.stringify({
    method,
    params,
    ...(targetTicket ? { targetTicket } : {}),
  } satisfies TranslatedInputCommand)});`;
  const userGesture = method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased';
  const result = (await wc.executeJavaScript(source, userGesture)) as TranslatedInputResult;
  if (result?.ok !== true) {
    throw new Error(result?.error ?? `failed to translate ${method}`);
  }
}

function nativeKeyCode(key: string): string | undefined {
  const known: Record<string, string> = {
    Backspace: 'BACKSPACE',
    Tab: 'TAB',
    Escape: 'ESCAPE',
    ArrowLeft: 'LEFT',
    ArrowUp: 'UP',
    ArrowRight: 'RIGHT',
    ArrowDown: 'DOWN',
    Delete: 'DELETE',
    Enter: 'ENTER',
    Home: 'HOME',
    End: 'END',
    PageUp: 'PAGEUP',
    PageDown: 'PAGEDOWN',
    Insert: 'INSERT',
  };
  return known[key];
}

function nativeModifiers(mask: number): string[] {
  return [
    ...(mask & 1 ? ['alt'] : []),
    ...(mask & 2 ? ['control'] : []),
    ...(mask & 4 ? ['meta'] : []),
    ...(mask & 8 ? ['shift'] : []),
  ];
}

async function dispatchClick(
  dispatchInput: InputDispatcher,
  x: number,
  y: number,
  request: BrowserActRequest,
  targetTicket?: string,
): Promise<void> {
  const button = mouseButton(request.button);
  const clickCount = request.doubleClick === true ? 2 : 1;
  const modifiers = modifierMask(request.modifiers);
  for (let count = 1; count <= clickCount; count += 1) {
    await dispatchInput(
      'Input.dispatchMouseEvent',
      {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: count,
        modifiers,
      },
      targetTicket,
    );
    if (typeof request.delayMs === 'number' && request.delayMs > 0) {
      await delay(Math.min(request.delayMs, 5_000));
    }
    await dispatchInput(
      'Input.dispatchMouseEvent',
      {
        type: 'mouseReleased',
        x,
        y,
        button,
        clickCount: count,
        modifiers,
      },
      targetTicket,
    );
  }
}

function parseKey(raw: string): { key: string; modifiers: number } {
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error('key required');
  return { key, modifiers: modifierMask(parts) };
}

async function dispatchKey(
  dispatchInput: InputDispatcher,
  rawKey: string,
  targetTicket?: string,
  nativeDispatch?: NativeKeyDispatcher,
  delayMs?: number,
): Promise<void> {
  const { key, modifiers } = parseKey(rawKey);
  const keyCode =
    nativeKeyCode(key) ?? (modifiers !== 0 && key.length === 1 ? key.toUpperCase() : undefined);
  // Printable unmodified characters and Enter retain the page-side path,
  // which emits the input/change events expected by web applications. Native
  // dispatch is reserved for navigation/editing keys whose browser defaults
  // cannot be reproduced by synthetic KeyboardEvents.
  if (nativeDispatch && keyCode) {
    const modifierNames = nativeModifiers(modifiers);
    await dispatchInput('Input.dispatchKeyEvent', { type: 'validate' }, targetTicket);
    await nativeDispatch('keyDown', keyCode, modifierNames);
    if (delayMs && delayMs > 0) await delay(Math.min(delayMs, 5_000));
    await nativeDispatch('keyUp', keyCode, modifierNames);
    return;
  }
  const text = key.length === 1 && modifiers === 0 ? key : undefined;
  await dispatchInput(
    'Input.dispatchKeyEvent',
    {
      type: 'keyDown',
      key,
      ...(text ? { text } : {}),
      modifiers,
    },
    targetTicket,
  );
  if (delayMs && delayMs > 0) await delay(Math.min(delayMs, 5_000));
  await dispatchInput(
    'Input.dispatchKeyEvent',
    {
      type: 'keyUp',
      key,
      modifiers,
    },
    targetTicket,
  );
}

export class RsbWebviewAutomation {
  private readonly refsByTab = new Map<string, Map<string, SnapshotRef>>();
  private readonly resourcesByTab = new Map<string, Set<string>>();
  private readonly barriersByTab = new Map<string, HumanVerificationBarrier>();

  constructor(private readonly logger: AutomationLogger) {}

  forgetTab(tabId: string): void {
    this.refsByTab.delete(tabId);
    this.resourcesByTab.delete(tabId);
    this.barriersByTab.delete(tabId);
  }

  getHumanVerificationBarrier(tabId: string): HumanVerificationBarrier | undefined {
    const barrier = this.barriersByTab.get(tabId);
    return barrier ? { kind: barrier.kind, evidence: [...barrier.evidence] } : undefined;
  }

  async snapshot(
    tabId: string,
    wc: WebContents,
    req: BrowserControlRequest,
  ): Promise<RsbSnapshotResult> {
    if (req.labels === true) {
      throw new Error('snapshot labels are unavailable in the embedded browser backend');
    }
    const snapshotReq =
      req.mode === 'efficient'
        ? {
            ...req,
            interactive: req.interactive ?? true,
            compact: req.compact ?? true,
            depth: req.depth ?? EFFICIENT_SNAPSHOT_DEPTH,
            maxChars: req.maxChars ?? EFFICIENT_SNAPSHOT_MAX_CHARS,
          }
        : req;
    return withDebugger(wc, async (send) => {
      let inspection: PageInspection = { resources: [] };
      try {
        inspection = await inspectPage(send, snapshotReq.urls === true);
      } catch (err) {
        this.logger.warn('failed to inspect page state', { tabId, err });
      }
      this.resourcesByTab.delete(tabId);
      if (inspection.resources.length > 0) {
        this.resourcesByTab.set(
          tabId,
          new Set(inspection.resources.map((resource) => resource.url)),
        );
      }
      if (inspection.barrier) {
        this.refsByTab.set(tabId, new Map());
        this.barriersByTab.set(tabId, inspection.barrier);
        return {
          format: snapshotReq.snapshotFormat ?? 'ai',
          targetId: tabId,
          url: wc.getURL(),
          ...(inspection.resources.length > 0 ? { resources: inspection.resources } : {}),
          barrier: inspection.barrier,
          stats: { lines: 0, chars: 0, refs: 0, interactive: 0 },
        };
      }
      this.barriersByTab.delete(tabId);
      await send('Accessibility.enable');
      let response: { nodes?: RawAxNode[] };
      const frame =
        typeof snapshotReq.frame === 'string' && snapshotReq.frame !== ''
          ? await resolveFrameRoot(send, snapshotReq.frame, snapshotReq.timeoutMs)
          : undefined;
      if (typeof snapshotReq.selector === 'string' && snapshotReq.selector !== '') {
        const selected = frame?.nodeId
          ? await resolveSelectorInFrame(send, frame.nodeId, snapshotReq.selector)
          : frame
            ? undefined
            : await resolveSelector(send, snapshotReq.selector, snapshotReq.timeoutMs);
        if (!selected) {
          throw new Error('frame document is unavailable for selector-scoped snapshot');
        }
        try {
          response = (await send('Accessibility.getPartialAXTree', {
            backendNodeId: selected.backendDOMNodeId,
            fetchRelatives: true,
          })) as { nodes?: RawAxNode[] };
        } finally {
          await releaseObject(send, selected.objectId);
        }
      } else {
        response = (await send(
          'Accessibility.getFullAXTree',
          frame ? { frameId: frame.frameId } : undefined,
        )) as { nodes?: RawAxNode[] };
      }

      const { tree, roots } = buildSnapshotTree(
        Array.isArray(response.nodes) ? response.nodes : [],
      );
      const refs: Record<string, SnapshotRef> = {};
      let refNumber = 1;
      const refOrder = tree
        .map((_node, index) => index)
        .toSorted(
          (left, right) =>
            Number(INTERACTIVE_ROLES.has(tree[right].role)) -
            Number(INTERACTIVE_ROLES.has(tree[left].role)),
        );
      for (const index of refOrder) {
        const node = tree[index];
        if (!shouldReference(node) || refNumber > MAX_SNAPSHOT_REFS) continue;
        const ref = `e${refNumber}`;
        refNumber += 1;
        node.ref = ref;
        refs[ref] = {
          role: node.role,
          ...(node.name ? { name: node.name } : {}),
          ...(node.value ? { value: node.value } : {}),
          backendDOMNodeId: node.backendDOMNodeId,
        };
      }

      if (snapshotReq.urls === true) {
        await Promise.all(
          tree
            .filter((node) => node.role === 'link' && node.ref)
            .map(async (node) => {
              try {
                node.url = await resolveHref(send, node.backendDOMNodeId);
              } catch (err) {
                this.logger.warn('failed to resolve snapshot link URL', { tabId, err });
              }
            }),
        );
      }

      const rawLines = renderSnapshotTree(tree, roots, snapshotReq);
      const lines = truncateSnapshotLines(rawLines, snapshotReq.maxChars);
      const visible = visibleRefs(refs, lines);
      this.refsByTab.set(tabId, new Map(Object.entries(visible)));
      const snapshot = lines.join('\n');
      const format = snapshotReq.snapshotFormat ?? 'ai';
      const stats = {
        lines: lines.length,
        chars: snapshot.length,
        refs: Object.keys(visible).length,
        interactive: Object.values(visible).filter((ref) => INTERACTIVE_ROLES.has(ref.role)).length,
      };
      if (format === 'aria') {
        const limit = positiveInt(req.limit, tree.length || 1, tree.length || 1);
        return {
          format,
          targetId: tabId,
          url: wc.getURL(),
          ...(inspection.resources.length > 0 ? { resources: inspection.resources } : {}),
          nodes: tree.slice(0, limit).map((node) => ({
            ...(node.ref && visible[node.ref] ? { ref: node.ref } : {}),
            role: node.role,
            ...(node.name ? { name: node.name } : {}),
            ...(node.value ? { value: node.value } : {}),
            backendDOMNodeId: node.backendDOMNodeId,
          })),
          stats,
        };
      }
      return {
        format,
        targetId: tabId,
        url: wc.getURL(),
        ...(inspection.resources.length > 0 ? { resources: inspection.resources } : {}),
        snapshot,
        refs: visible,
        stats,
      };
    });
  }

  assertResource(tabId: string, url: string): void {
    if (!this.resourcesByTab.get(tabId)?.has(url)) {
      throw new Error('resource is not present in the latest page resource list');
    }
  }

  async evaluate(
    tabId: string,
    wc: WebContents,
    request: Pick<BrowserActRequest, 'fn' | 'ref' | 'timeoutMs'>,
  ): Promise<unknown> {
    if (typeof request.fn !== 'string' || request.fn === '') {
      throw new Error('evaluate.fn (JS expression source) required');
    }
    const timeoutMs = positiveInt(request.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
    return withDebugger(wc, async (send) => {
      let response: {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (request.ref) {
        const snapshotRef = this.refsByTab.get(tabId)?.get(request.ref);
        if (!snapshotRef) {
          throw new Error(`unknown or stale snapshot ref: ${request.ref}; take a new snapshot`);
        }
        const target = await resolveRef(send, snapshotRef);
        try {
          response = (await send('Runtime.callFunctionOn', {
            objectId: target.objectId,
            functionDeclaration: `function(fnSource) {
              var candidate = eval("(" + fnSource + ")");
              if (typeof candidate !== "function") {
                throw new Error("evaluate source did not produce a function");
              }
              return Promise.resolve(candidate(this));
            }`,
            arguments: [{ value: request.fn }],
            awaitPromise: true,
            returnByValue: true,
            timeout: timeoutMs,
          })) as typeof response;
        } finally {
          await releaseObject(send, target.objectId);
        }
      } else {
        response = (await send('Runtime.evaluate', {
          expression: `(() => {
            var candidate = eval("(" + ${JSON.stringify(request.fn)} + ")");
            if (typeof candidate !== "function") {
              throw new Error("evaluate source did not produce a function");
            }
            return Promise.resolve(candidate());
          })()`,
          awaitPromise: true,
          returnByValue: true,
          timeout: timeoutMs,
        })) as typeof response;
      }
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text ??
            'evaluate failed',
        );
      }
      return response.result?.value;
    });
  }

  async setFiles(
    tabId: string,
    wc: WebContents,
    req: Pick<
      BrowserControlRequest,
      'paths' | 'ref' | 'inputRef' | 'element' | 'query' | 'timeoutMs'
    >,
  ): Promise<{ tabId: string; uploadedFiles: number }> {
    return withDebugger(wc, async (send) => {
      let target: ResolvedNode;
      if (req.query && typeof req.query === 'object') {
        target = await resolveElementQuery(send, req.query, req.timeoutMs, { allowHidden: true });
      } else if (typeof req.element === 'string' && req.element !== '') {
        target = await resolveSelector(send, req.element, req.timeoutMs, { allowHidden: true });
      } else {
        const ref = req.inputRef ?? req.ref;
        if (typeof ref !== 'string' || ref === '') {
          throw new Error('upload requires inputRef, ref, element, or query');
        }
        const snapshotRef = this.refsByTab.get(tabId)?.get(ref);
        if (!snapshotRef) {
          throw new Error(`unknown or stale snapshot ref: ${ref}; take a new snapshot`);
        }
        target = await resolveRef(send, snapshotRef);
      }

      try {
        const readiness = await callOnNode<{
          ok: boolean;
          reason?: string;
          multiple?: boolean;
        }>(
          send,
          target.objectId,
          `function() {
            if (!(this instanceof HTMLInputElement) || this.type !== "file") {
              return { ok: false, reason: "upload target is not a file input" };
            }
            if (!this.isConnected) return { ok: false, reason: "upload target is detached" };
            if (this.disabled || this.getAttribute("aria-disabled") === "true") {
              return { ok: false, reason: "upload target is disabled" };
            }
            return { ok: true, multiple: this.multiple };
          }`,
        );
        if (!readiness?.ok) {
          throw new Error(readiness?.reason ?? 'upload target is not ready');
        }
        const paths = req.paths ?? [];
        if (paths.length > 1 && readiness.multiple !== true) {
          throw new Error('upload target accepts only one file');
        }
        await send('DOM.setFileInputFiles', {
          files: paths,
          objectId: target.objectId,
        });
        return {
          tabId,
          uploadedFiles: paths.length,
        };
      } finally {
        await releaseObject(send, target.objectId);
      }
    });
  }

  async act(
    tabId: string,
    wc: WebContents,
    request: BrowserActRequest,
    options?: {
      nativeKeyDispatch?: NativeKeyDispatcher;
      waitForNetworkIdle?: (timeoutMs: number) => Promise<void>;
    },
  ): Promise<RsbActResult> {
    return withDebugger(wc, async (send) => {
      const dispatchInput: InputDispatcher = async (method, params, targetTicket) => {
        await dispatchTranslatedInput(wc, method, params, targetTicket);
      };
      const resolveTarget = async (
        ref = request.ref,
        selector = request.selector,
        query = request.query,
      ): Promise<ResolvedNode> => {
        if (query && typeof query === 'object') {
          return resolveElementQuery(send, query, request.timeoutMs);
        }
        if (typeof selector === 'string' && selector !== '') {
          return resolveSelector(send, selector, request.timeoutMs);
        }
        if (typeof ref !== 'string' || ref === '') {
          throw new Error(`${request.kind} requires ref, selector, or query`);
        }
        const target = this.refsByTab.get(tabId)?.get(ref);
        if (!target) throw new Error(`unknown or stale snapshot ref: ${ref}; take a new snapshot`);
        return resolveRef(send, target);
      };

      switch (request.kind) {
        case 'saveResource':
          throw new Error('saveResource must be handled by the browser artifact manager');
        case 'click': {
          return withReleasedNode(send, resolveTarget, async (target) => {
            await waitForActionable(send, target, { timeoutMs: request.timeoutMs });
            const ticket = await stampActionTarget(send, target);
            const point = await centerOfNode(send, target);
            await dispatchClick(dispatchInput, point.x, point.y, request, ticket);
            return { tabId, kind: request.kind, ...point };
          });
        }
        case 'clickCoords': {
          const x = finiteNonNegative(request.x, 'clickCoords.x');
          const y = finiteNonNegative(request.y, 'clickCoords.y');
          await dispatchClick(dispatchInput, x, y, request);
          return { tabId, kind: request.kind, x, y };
        }
        case 'fill': {
          if (Array.isArray(request.fields) && request.fields.length > 0) {
            let filled = 0;
            for (const rawField of request.fields) {
              if (!rawField || typeof rawField !== 'object') {
                throw new Error('fill.fields entries must be objects');
              }
              const field = rawField as Record<string, unknown>;
              if (typeof field.ref !== 'string' || field.ref === '') {
                throw new Error('fill.fields[].ref required');
              }
              const fieldRef = field.ref;
              await withReleasedNode(
                send,
                () => resolveTarget(fieldRef, undefined, undefined),
                async (target) => {
                  await waitForActionable(send, target, { timeoutMs: request.timeoutMs });
                  await fillNode(
                    send,
                    target,
                    field.value,
                    typeof field.type === 'string' ? field.type : undefined,
                  );
                },
              );
              filled += 1;
            }
            return { tabId, kind: request.kind, filled };
          }
          // Keep the single-target form accepted by existing embedded-backend
          // callers while also honoring the shared multi-field contract above.
          return withReleasedNode(send, resolveTarget, async (target) => {
            await waitForActionable(send, target, {
              editable: true,
              timeoutMs: request.timeoutMs,
            });
            await focusNode(send, target, true);
            if (typeof request.text !== 'string') throw new Error('fill.text required');
            await fillNode(send, target, request.text);
            if (request.submit === true) {
              const ticket = await stampActionTarget(send, target);
              await dispatchKey(dispatchInput, 'Enter', ticket);
            }
            return { tabId, kind: request.kind, textLength: request.text.length };
          });
        }
        case 'type': {
          return withReleasedNode(send, resolveTarget, async (target) => {
            await waitForActionable(send, target, {
              editable: true,
              timeoutMs: request.timeoutMs,
            });
            await focusNode(send, target, true);
            const ticket = await stampActionTarget(send, target);
            if (typeof request.text !== 'string') throw new Error('type.text required');
            const structured = await callOnNode<boolean>(
              send,
              target.objectId,
              `function() {
                return this instanceof HTMLInputElement
                  && ["date", "datetime-local", "month", "time", "week"].includes(this.type);
              }`,
            );
            if (structured) {
              await fillNode(send, target, request.text);
            } else if (request.slowly === true) {
              const perCharacterDelay = Math.min(request.delayMs ?? 50, 1_000);
              for (const character of Array.from(request.text)) {
                await dispatchInput('Input.insertText', { text: character }, ticket);
                if (perCharacterDelay > 0) await delay(perCharacterDelay);
              }
            } else {
              await selectEditableContents(send, target);
              await dispatchInput('Input.insertText', { text: request.text }, ticket);
            }
            if (request.submit === true) await dispatchKey(dispatchInput, 'Enter', ticket);
            return { tabId, kind: request.kind, textLength: request.text.length };
          });
        }
        case 'press': {
          let ticket: string | undefined;
          if (request.ref || request.selector || request.query) {
            return withReleasedNode(send, resolveTarget, async (target) => {
              await waitForActionable(send, target, { timeoutMs: request.timeoutMs });
              await focusNode(send, target);
              const targetTicket = await stampActionTarget(send, target);
              if (typeof request.key !== 'string' || request.key === '') {
                throw new Error('press.key required');
              }
              await dispatchKey(
                dispatchInput,
                request.key,
                targetTicket,
                options?.nativeKeyDispatch,
                request.delayMs,
              );
              return { tabId, kind: request.kind, key: request.key };
            });
          }
          if (typeof request.key !== 'string' || request.key === '') {
            throw new Error('press.key required');
          }
          await dispatchKey(
            dispatchInput,
            request.key,
            ticket,
            options?.nativeKeyDispatch,
            request.delayMs,
          );
          return { tabId, kind: request.kind, key: request.key };
        }
        case 'hover': {
          return withReleasedNode(send, resolveTarget, async (target) => {
            await waitForActionable(send, target, { timeoutMs: request.timeoutMs });
            const ticket = await stampActionTarget(send, target);
            const point = await centerOfNode(send, target, { focus: false });
            await dispatchInput(
              'Input.dispatchMouseEvent',
              {
                type: 'mouseMoved',
                x: point.x,
                y: point.y,
                modifiers: modifierMask(request.modifiers),
              },
              ticket,
            );
            return { tabId, kind: request.kind, ...point };
          });
        }
        case 'drag': {
          let startTarget: ResolvedNode | undefined;
          let endTarget: ResolvedNode | undefined;
          try {
            const resolvedStart = await resolveTarget(request.startRef, undefined);
            startTarget = resolvedStart;
            const resolvedEnd = await resolveTarget(request.endRef, undefined);
            endTarget = resolvedEnd;
            const start = await centerOfNode(send, resolvedStart);
            const end = await centerOfNode(send, resolvedEnd);
            await send('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: start.x,
              y: start.y,
            });
            await send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: start.x,
              y: start.y,
              button: 'left',
              clickCount: 1,
            });
            for (let step = 1; step <= 8; step += 1) {
              const ratio = step / 8;
              await send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: start.x + (end.x - start.x) * ratio,
                y: start.y + (end.y - start.y) * ratio,
                button: 'left',
                buttons: 1,
              });
            }
            await send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: end.x,
              y: end.y,
              button: 'left',
              clickCount: 1,
            });
            return { tabId, kind: request.kind, start, end };
          } finally {
            await releaseObject(send, startTarget?.objectId);
            await releaseObject(send, endTarget?.objectId);
          }
        }
        case 'select': {
          return withReleasedNode(send, resolveTarget, async (target) => {
            await waitForActionable(send, target, { timeoutMs: request.timeoutMs });
            const values = Array.isArray(request.values)
              ? request.values.filter((value): value is string => typeof value === 'string')
              : [];
            if (values.length === 0) throw new Error('select.values required');
            const selected = await callOnNode<string[]>(
              send,
              target.objectId,
              `function(values) {
              if (!(this instanceof HTMLSelectElement)) throw new Error("target is not a select element");
              if (values.length > 1 && !this.multiple) {
                throw new Error("target select does not accept multiple values");
              }
              const missing = values.filter((value) => (
                !Array.from(this.options).some((option) => (
                  option.value === value || option.label === value
                ))
              ));
              if (missing.length > 0) {
                throw new Error("select options not found: " + missing.join(", "));
              }
              for (const option of this.options) {
                option.selected = values.includes(option.value) || values.includes(option.label);
              }
              this.dispatchEvent(new Event("input", { bubbles: true }));
              this.dispatchEvent(new Event("change", { bubbles: true }));
              return Array.from(this.selectedOptions, option => option.value);
            }`,
              [values],
            );
            return { tabId, kind: request.kind, values: selected };
          });
        }
        case 'resize': {
          if (request.width === undefined && request.height === undefined) {
            await send('Emulation.clearDeviceMetricsOverride');
            return { tabId, kind: request.kind, reset: true };
          }
          const width = positiveInt(request.width, 0, 16_384);
          const height = positiveInt(request.height, 0, 16_384);
          if (width <= 0 || height <= 0) throw new Error('resize width and height required');
          await send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile: false,
          });
          return { tabId, kind: request.kind, width, height };
        }
        case 'wait': {
          const waitDeadline =
            Date.now() +
            positiveInt(request.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS);
          const timeMs = Math.min(
            typeof request.timeMs === 'number' && request.timeMs >= 0 ? request.timeMs : 0,
            MAX_WAIT_TIMEOUT_MS,
          );
          if (timeMs > 0) await delay(timeMs);
          const timeoutMs = positiveInt(
            request.timeoutMs,
            DEFAULT_WAIT_TIMEOUT_MS,
            MAX_WAIT_TIMEOUT_MS,
          );
          const hasCondition = Boolean(
            request.selector ||
            request.url ||
            request.loadState ||
            request.text ||
            request.textGone ||
            request.fn,
          );
          if (hasCondition) {
            const params = {
              selector: request.selector,
              url: request.url,
              loadState: request.loadState,
              text: request.text,
              textGone: request.textGone,
              fn: request.fn,
              timeoutMs,
            };
            const result = (await send('Runtime.evaluate', {
              expression: `(() => {
                const params = ${JSON.stringify(params)};
                const deadline = Date.now() + params.timeoutMs;
                let predicate;
                if (params.fn) {
                  predicate = eval("(" + params.fn + ")");
                  if (typeof predicate !== "function") throw new Error("wait.fn did not produce a function");
                }
                const matches = async () => {
                  if (params.selector) {
                    const element = document.querySelector(params.selector);
                    if (!element) return false;
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    if (
                      style.display === "none"
                      || style.visibility === "hidden"
                      || style.visibility === "collapse"
                      || rect.width <= 0
                      || rect.height <= 0
                    ) return false;
                  }
                  if (params.url && location.href !== params.url && !location.href.includes(params.url)) return false;
                  if (params.text && !(document.body?.innerText || "").includes(params.text)) return false;
                  if (params.textGone && (document.body?.innerText || "").includes(params.textGone)) return false;
                  if (params.loadState === "load" && document.readyState !== "complete") return false;
                  if (params.loadState === "domcontentloaded" && document.readyState === "loading") return false;
                  if (params.loadState === "networkidle" && document.readyState !== "complete") return false;
                  if (predicate && !await Promise.resolve(predicate())) return false;
                  return true;
                };
                return new Promise((resolve, reject) => {
                  const poll = async () => {
                    try {
                      if (await matches()) return resolve({ url: location.href, readyState: document.readyState });
                      if (Date.now() >= deadline) return reject(new Error("wait timed out"));
                      setTimeout(poll, 100);
                    } catch (error) {
                      reject(error);
                    }
                  };
                  void poll();
                });
              })()`,
              awaitPromise: true,
              returnByValue: true,
              timeout: timeoutMs + 1_000,
            })) as {
              result?: { value?: unknown };
              exceptionDetails?: { exception?: { description?: string }; text?: string };
            };
            if (result.exceptionDetails) {
              throw new Error(
                result.exceptionDetails.exception?.description ??
                  result.exceptionDetails.text ??
                  'wait failed',
              );
            }
            if (request.loadState === 'networkidle') {
              const remainingMs = waitDeadline - Date.now();
              if (remainingMs <= 0) throw new Error('wait timed out');
              await options?.waitForNetworkIdle?.(remainingMs);
            }
            return { tabId, kind: request.kind, waitedMs: timeMs, state: result.result?.value };
          }
          return { tabId, kind: request.kind, waitedMs: timeMs };
        }
        case 'evaluate':
        case 'close':
          throw new Error(`${request.kind} is handled by the backend`);
      }
    });
  }
}
