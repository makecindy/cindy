import type { BrowserControlRequest, BrowserControlRuntime } from '@cindy/browser-control-runtime';

/**
 * Raw protocol methods the agent may send through `action: "cdp"`.
 *
 * A subset of the runtime's own adapter allowlist (`recipe-command.ts`), which stays the hard
 * boundary underneath. Left out on purpose: cookie reads (credentials stay out of the model) and
 * raw screenshots (binary; the `screenshot` action returns a bounded image). Navigation, tabs,
 * downloads and uploads keep their normal actions and policy checks.
 */
const RAW_METHODS = new Set([
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getContentQuads',
  'DOM.getBoxModel',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.insertText',
  'Page.getLayoutMetrics',
  'Page.getFrameTree',
  'Page.handleJavaScriptDialog',
  'Runtime.callFunctionOn',
  'Runtime.releaseObject',
]);
const HELPERS = new Set(['nodes', 'click', 'type', 'call']);

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
}

/** Message for the first command the agent may not send, checked before anything is dispatched. */
export function cdpCommandIssue(commands: CdpCommand[]): string | undefined {
  const bad = commands.find((command) => !HELPERS.has(command.method) && !RAW_METHODS.has(command.method));
  if (!bad) return undefined;
  return `cdp 不支持 "${bad.method}"。可用辅助命令:nodes / click / type / call;可用原始命令:${[...RAW_METHODS].join('、')}。` +
    '导航、标签页、截图、上传、下载和 Cookie 不走 cdp,用对应的普通 action。';
}

interface AxNode {
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
  parentId?: string;
  nodeId?: string;
}

const AX_SKIPPED_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation']);
const AX_STATES = ['disabled', 'checked', 'expanded', 'selected', 'focused', 'required', 'invalid'];

/**
 * One `[id] role "name"` line per meaningful node; `id` is the backend DOM node id the helper
 * commands take. The accessibility tree includes closed shadow roots, which a page snapshot and
 * page script cannot reach. Pure, so its bounds are testable without a browser.
 */
export function compactAxTree(
  nodes: unknown,
  options: { filter?: string; maxChars?: number } = {},
): { nodes: string; count: number; truncated?: true; hint?: string } {
  const list = Array.isArray(nodes) ? (nodes as AxNode[]) : [];
  const names = new Map<string, string>();
  for (const node of list) {
    if (typeof node.nodeId === 'string' && typeof node.name?.value === 'string') names.set(node.nodeId, node.name.value);
  }
  const filter = options.filter?.trim().toLowerCase();
  const maxChars = Math.max(500, Math.min(options.maxChars ?? 6000, 20_000));
  const lines: string[] = [];
  let chars = 0;
  let matched = 0;
  for (const node of list) {
    const role = typeof node.role?.value === 'string' ? node.role.value : '';
    if (node.ignored || !role || AX_SKIPPED_ROLES.has(role) || typeof node.backendDOMNodeId !== 'number') continue;
    const name = typeof node.name?.value === 'string' ? node.name.value.trim() : '';
    const value = node.value?.value;
    if (!name && (value === undefined || value === '')) continue;
    // Text already carried by the parent's name (a button's label) adds nothing.
    if (role === 'StaticText' && node.parentId && (names.get(node.parentId) ?? '').includes(name)) continue;
    let line = `[${node.backendDOMNodeId}] ${role} ${JSON.stringify(name.slice(0, 160))}`;
    if (value !== undefined && value !== '') line += ` value=${JSON.stringify(String(value).slice(0, 80))}`;
    for (const property of node.properties ?? []) {
      const state = property.value?.value;
      if (!property.name || !AX_STATES.includes(property.name) || state === undefined || state === false || state === 'false') continue;
      line += state === true || state === 'true' ? ` ${property.name}` : ` ${property.name}=${String(state)}`;
    }
    if (filter && !line.toLowerCase().includes(filter)) continue;
    matched++;
    if (chars + line.length + 1 > maxChars) continue;
    chars += line.length + 1;
    lines.push(line);
  }
  return {
    nodes: lines.join('\n'),
    count: matched,
    ...(lines.length < matched
      ? { truncated: true as const, hint: `只列出前 ${lines.length} 项;用 params.filter 按角色或名称收窄,或加大 maxChars。` }
      : {}),
  };
}

function bounded(value: unknown, maxChars = 8000): unknown {
  const json = JSON.stringify(value);
  if (json === undefined || json.length <= maxChars) return value;
  return { truncated: true, chars: json.length, preview: json.slice(0, maxChars), hint: '结果过大已截断;用更窄的命令或 nodes 的 filter。' };
}

function nodeId(params: Record<string, unknown> | undefined): number {
  const id = params?.node ?? params?.backendNodeId;
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('需要 params.node(nodes 返回的方括号里的数字)');
  return id;
}

const READ_FIELD = 'function(){ return "value" in this ? this.value : this.textContent }';
/** The prototype setter, so frameworks that wrap `value` on the element still see the change. */
const SET_FIELD = `function(text){
  if ("value" in this) {
    const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : this instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(this, text); else this.value = text;
  } else if (this.isContentEditable) {
    this.textContent = text;
  } else {
    return undefined;
  }
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "value" in this ? this.value : this.textContent;
}`;

export interface CdpStepResult {
  method: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Run the commands in one protocol session on one tab, in order, stopping at the first failure.
 * Node and object ids stay valid for the whole call; the session always ends with it, so nothing
 * stays attached between tool calls.
 */
export async function runCdpCommands(
  runtime: BrowserControlRuntime,
  target: { profile?: string; targetId: string },
  commands: CdpCommand[],
  options: { maxChars?: number } = {},
): Promise<{ ok: boolean; targetId: string; results: CdpStepResult[]; message?: string }> {
  const base = target.profile ? { profile: target.profile } : {};
  const opened = await runtime.call({
    action: 'recipeCommand', ...base, targetId: target.targetId, recipeCommand: { method: 'Cindy.begin' },
  } as BrowserControlRequest);
  const begun = opened.data as { sessionId?: unknown; targetId?: unknown } | undefined;
  if (!opened.ok || typeof begun?.sessionId !== 'string') {
    return { ok: false, targetId: target.targetId, results: [], message: opened.message ?? '无法连接该标签页的调试协议' };
  }
  const sessionId = begun.sessionId;
  // The runtime scopes the session to the resolved tab id, which may differ from a label or alias.
  const targetId = typeof begun.targetId === 'string' && begun.targetId ? begun.targetId : target.targetId;
  const send = async (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const sent = await runtime.call({
      action: 'recipeCommand', ...base, targetId, recipeCommand: { method, sessionId, ...(params ? { params } : {}) },
    } as BrowserControlRequest);
    if (!sent.ok) throw new Error(sent.message ?? `${method} failed`);
    const data = (sent.data ?? {}) as Record<string, unknown>;
    // A script that throws in the page still comes back as a successful protocol response, with the
    // exception beside the result. Any command, helper or raw, counts as failed then, so the sequence
    // (and a batch around it) stops instead of going on to e.g. a submit click on unchanged data.
    const failure = data.exceptionDetails as { exception?: { description?: unknown }; text?: unknown } | undefined;
    if (failure) throw new Error(String(failure.exception?.description ?? failure.text ?? '页面里的函数执行出错').slice(0, 500));
    return data;
  };
  const callOn = async (backendNodeId: number, fn: string, args: unknown[] = []): Promise<unknown> => {
    const resolved = await send('DOM.resolveNode', { backendNodeId });
    const objectId = (resolved.object as { objectId?: unknown } | undefined)?.objectId;
    if (typeof objectId !== 'string') throw new Error('节点已不存在;重新用 nodes 获取 id');
    try {
      const called = await send('Runtime.callFunctionOn', {
        objectId, functionDeclaration: fn, returnByValue: true, awaitPromise: true, userGesture: true,
        ...(args.length ? { arguments: args.map((value) => ({ value })) } : {}),
      });
      return (called.result as { value?: unknown } | undefined)?.value;
    } finally {
      await send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  };
  const results: CdpStepResult[] = [];
  try {
    for (const { method, params } of commands) {
      try {
        let result: unknown;
        if (method === 'nodes') {
          const tree = await send('Accessibility.getFullAXTree', {});
          result = compactAxTree(tree.nodes, {
            filter: typeof params?.filter === 'string' ? params.filter : undefined,
            maxChars: typeof params?.maxChars === 'number' ? params.maxChars : options.maxChars,
          });
        } else if (method === 'click') {
          const backendNodeId = nodeId(params);
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const quad = ((await send('DOM.getContentQuads', { backendNodeId })).quads as number[][] | undefined)?.[0];
          if (!quad || quad.length < 8) throw new Error('节点没有可见区域,无法点击');
          const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
          const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          result = { clicked: backendNodeId, x, y };
        } else if (method === 'type') {
          const backendNodeId = nodeId(params);
          if (typeof params?.text !== 'string') throw new Error('type 需要 params.text');
          await send('DOM.focus', { backendNodeId }).catch((err) => {
            throw new Error(`该节点不能输入(${err instanceof Error ? err.message : String(err)});选 nodes 里角色是 textbox / searchbox / combobox 的那一行`);
          });
          // Replace what the field holds, like the normal `type` action.
          await callOn(backendNodeId, 'function(){ if (typeof this.select === "function") this.select(); }');
          await send('Input.insertText', { text: params.text });
          // A page without focus (the sidebar keeps its pages in the background) takes no inserted text
          // and reports no error. Check what the field holds; set it directly when the text did not land.
          let via = 'insertText';
          if (await callOn(backendNodeId, READ_FIELD) !== params.text) {
            via = 'value';
            if (await callOn(backendNodeId, SET_FIELD, [params.text]) !== params.text) {
              throw new Error('输入没有生效:该节点不接受文字,或页面改写了输入。用 nodes / call 看它现在的内容再决定');
            }
          }
          result = { typed: backendNodeId, via };
        } else if (method === 'call') {
          if (typeof params?.fn !== 'string') throw new Error('call 需要 params.fn,例如 "function(){ return this.textContent }"');
          result = bounded(await callOn(nodeId(params), params.fn), options.maxChars);
        } else {
          result = bounded(await send(method, params), options.maxChars);
        }
        results.push({ method, ok: true, ...(result === undefined ? {} : { result }) });
      } catch (err) {
        results.push({ method, ok: false, error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
  } finally {
    await runtime.call({
      action: 'recipeCommand', ...base, targetId, recipeCommand: { method: 'Cindy.end', sessionId },
    } as BrowserControlRequest).catch(() => undefined);
  }
  return { ok: results.length === commands.length && results.every((step) => step.ok), targetId, results };
}
