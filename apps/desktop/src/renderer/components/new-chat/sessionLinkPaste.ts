/**
 * sessionLinkPaste — 会话深链粘贴 chip 的 session 专属逻辑(attrs 构造 /
 * 序列化 / 标题异步解析)。
 *
 * 粘贴文本的**分段**在 pastePipeline.ts(统一管线:长文本 / session /
 * project / path);本文件只负责 session 段落地后的部分:
 *   - 整段会话 markdown 形式自带标题 → chip 直接显示该标题(titled=true);
 *   - 整段会话裸 URL → 先显示短会话 ID 占位(titled=false),随后
 *     `resolveSessionChipTitles` 异步查到标题后原地 patch 节点 attrs;
 *   - 消息锚点始终忽略会话标题/markdown label,异步读取目标消息正文,
 *     wire text 仍序列化原始深链，同时把有上限的完整正文放进结构化
 *     agent reference metadata；compact label 只负责 UI 展示。
 *     (addToHistory:false,不污染撤销栈)——先占位再增量刷新,不产生
 *     空白帧 / 跳变(设计规范规则 7)。
 *
 * 发送时的序列化(serializeSessionChipText):titled 的 chip 还原成
 * `[标题](href)` markdown 链接(消息侧 SessionLinkChip 显式 label 优先,
 * 手机端 MarkdownBody 同样支持),未解析出标题的还原成裸 href。标题里的
 * ASCII 方括号会破坏 markdown 链接语法,清洗为空格。
 */
import type { Editor } from '@tiptap/core';
import { boundAgentReferenceText } from '@cindy/maker-shared/agent-input-projection';
import { projectDraftSessionTitle } from '@cindy/maker-shared/session-title';

import { i18n } from '@/i18n';
import { parseSessionDeepLinkHref } from '@/lib/deepLink';
import { shortSessionId } from '@/lib/sessionId';

import type { MentionChipAttrs } from './MentionChipNode';

/** Visible chip labels stay compact; the full bounded body is separate semantic metadata. */
export const SESSION_MESSAGE_CHIP_LABEL_MAX_CHARS = 240;

export function summarizeSessionMessageChipLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SESSION_MESSAGE_CHIP_LABEL_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, SESSION_MESSAGE_CHIP_LABEL_MAX_CHARS - 1)}…`;
}

/**
 * 序列化用 label 清洗:
 *   - ASCII 方括号破坏 `[..](..)` 语法 → 换空格;
 *   - `@` 会被 UserMessage 的 mention 切词先于 linkify 拆碎(标题含
 *     `@src/App.tsx` / 邮箱时整段 markdown 形式失效,PR #970 review P2)
 *     → 归一为全角 `＠`(视觉近似,发送文本对 mention 解析安全)。
 */
export function sanitizeSessionChipTitle(title: string): string {
  return title.replace(/[[\]]/g, ' ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
}

/** 粘贴段 → session chip 的节点 attrs(带标题即 titled,否则短 ID 占位)。 */
export function pastedSessionChipAttrs(seg: {
  href: string;
  label: string | null;
}): MentionChipAttrs {
  const target = parseSessionDeepLinkHref(seg.href);
  const sessionId = target?.sessionId ?? seg.href;
  if (target?.messageClientId) {
    return {
      kind: 'session',
      label: shortSessionId(target.messageClientId),
      path: seg.href,
      titled: false,
    };
  }
  const label = seg.label ? sanitizeSessionChipTitle(seg.label) : '';
  return label
    ? { kind: 'session', label, path: seg.href, titled: true }
    : { kind: 'session', label: shortSessionId(sessionId), path: seg.href, titled: false };
}

/** session chip → 发送文本:有标题 `[标题](href)`,无标题裸 href。 */
export function serializeSessionChipText(attrs: MentionChipAttrs): string {
  if (parseSessionDeepLinkHref(attrs.path)?.messageClientId) return attrs.path;
  return attrs.titled && attrs.label ? `[${attrs.label}](${attrs.path})` : attrs.path;
}

/** 默认消息正文解析:按会话来源路由到本机或 device-link 被控端。 */
export async function resolvePastedSessionMessageText(
  sessionId: string,
  clientId: string,
): Promise<string | null> {
  const { resolveSessionMessageText } = await import('@/lib/sessionMessageText');
  return resolveSessionMessageText(sessionId, clientId);
}

/**
 * 默认标题解析:本地库 → device-link 远程会话镜像 → null(保持短 ID)。
 * 降级顺序与消息侧 SessionLinkChip 一致。服务依赖走动态 import:本模块的
 * 纯函数(分段 / 序列化)被单测直接引用,不把 sessionService 的传输层
 * import 图拖进测试环境;app 运行时这些模块早已被 ChatInput 加载,动态
 * import 命中缓存无额外开销。
 */
export async function resolvePastedSessionTitle(sessionId: string): Promise<string | null> {
  const sessionService = await import('@/lib/sessionService');
  try {
    const session = await sessionService.get(sessionId);
    const title = session.title?.trim();
    if (title) return projectResolvedChipTitle(title);
  } catch {
    // 本地库没有(远程 / 未知会话)→ 走远程镜像降级
  }
  const { remoteProjectsStore } = await import('@/features/device-link/remoteProjectsStore');
  const remote = remoteProjectsStore.getMergedRemoteSessions().find((s) => s.id === sessionId);
  const remoteTitle = remote?.title?.trim();
  return remoteTitle ? projectResolvedChipTitle(remoteTitle) : null;
}

/**
 * 解析器查到的标题在**序列化进消息文本之前**先过哨兵投影。
 *
 * 为什么必须在这一刻、而不是渲染时:这个串会被 `serializeSessionChipText` 写成
 * `[标题](href)` 进入**消息正文**,之后对消息侧 `SessionLinkChip` 来说它就是
 * `explicitLabel`(作者显式写下的 label,渲染层理应原样尊重、不做投影)。所以原始
 * 哨兵一旦被序列化进去就**永久**留在消息里,渲染时的投影救不回来
 * (PR #1031 review P1)。
 *
 * 只投影**自动解析出来的**标题;用户自己在 markdown 里写的 label 走
 * `titled=true` 分支,压根不经过本函数,不受影响。
 */
function projectResolvedChipTitle(title: string): string {
  return projectDraftSessionTitle(title, i18n.t('ccAgent.common.unnamedSession'));
}

const pendingMessageResolutions = new WeakMap<Editor, Map<string, Promise<void>>>();

function patchResolvedMessageChip(editor: Editor, path: string, value: string): void {
  const display = summarizeSessionMessageChipLabel(value);
  if (!display || editor.isDestroyed) return;
  const agentText = boundAgentReferenceText(value);
  const tr = editor.state.tr;
  let changed = false;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'mentionChip') return;
    const attrs = node.attrs as MentionChipAttrs;
    if (attrs.kind !== 'session' || attrs.path !== path) return;
    tr.setNodeMarkup(pos, undefined, {
      ...attrs,
      label: display,
      titled: true,
      agentText: agentText.text,
      ...(agentText.truncated ? { agentTextTruncated: true } : {}),
    });
    changed = true;
  });
  if (!changed) return;
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

function resolveMessageChip(
  editor: Editor,
  path: string,
  target: NonNullable<ReturnType<typeof parseSessionDeepLinkHref>>,
  resolveMessageText: (sessionId: string, clientId: string) => Promise<string | null>,
): Promise<void> {
  let editorPending = pendingMessageResolutions.get(editor);
  if (!editorPending) {
    editorPending = new Map();
    pendingMessageResolutions.set(editor, editorPending);
  }
  const existing = editorPending.get(path);
  if (existing) return existing;

  const pending = resolveMessageText(target.sessionId, target.messageClientId!)
    .then((value) => {
      if (value) patchResolvedMessageChip(editor, path, value);
    })
    .catch(() => {
      // Keep the short-id placeholder when the target is unavailable.
    })
    .finally(() => {
      editorPending?.delete(path);
      if (editorPending?.size === 0) pendingMessageResolutions.delete(editor);
    });
  editorPending.set(path, pending);
  return pending;
}

/**
 * Resolve every message chip that still lacks a bounded semantic body.
 * Sending awaits this so a fast submit cannot outrun cross-device hydration.
 */
export async function resolveSessionMessageReferencesForSend(
  editor: Editor,
  resolveMessageText: (
    sessionId: string,
    clientId: string,
  ) => Promise<string | null> = resolvePastedSessionMessageText,
): Promise<void> {
  const pendingTargets = new Map<
    string,
    NonNullable<ReturnType<typeof parseSessionDeepLinkHref>>
  >();
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'mentionChip') return;
    const attrs = node.attrs as MentionChipAttrs;
    if (attrs.kind !== 'session' || attrs.agentText) return;
    const target = parseSessionDeepLinkHref(attrs.path);
    if (target?.messageClientId) pendingTargets.set(attrs.path, target);
  });
  await Promise.all(
    [...pendingTargets].map(([path, target]) => (
      resolveMessageChip(editor, path, target, resolveMessageText)
    )),
  );
}

/**
 * 扫描编辑器里所有未解析标题(titled=false)的 session chip,异步查标题后
 * 原地 patch 节点 attrs。要点:
 *   - 解析回来后按「当时」的文档重新定位节点(粘贴后用户可能已编辑,
 *     不能缓存粘贴时的位置);
 *   - patch 事务标 addToHistory:false——撤销粘贴应一步回到粘贴前,
 *     不该先退回「短 ID 占位」中间态;
 *   - 查不到标题(远程离线 / 会话已删)→ 保持短 ID,序列化走裸 href。
 */
export function resolveSessionChipTitles(
  editor: Editor,
  resolveTitle: (sessionId: string) => Promise<string | null> = resolvePastedSessionTitle,
  resolveMessageText: (
    sessionId: string,
    clientId: string,
  ) => Promise<string | null> = resolvePastedSessionMessageText,
): void {
  void resolveSessionMessageReferencesForSend(editor, resolveMessageText);
  const pendingTargets = new Map<
    string,
    NonNullable<ReturnType<typeof parseSessionDeepLinkHref>>
  >();
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'mentionChip') return;
    const attrs = node.attrs as MentionChipAttrs;
    if (attrs.kind !== 'session' || attrs.titled) return;
    const target = parseSessionDeepLinkHref(attrs.path);
    if (target && !target.messageClientId) pendingTargets.set(attrs.path, target);
  });
  for (const [path, target] of pendingTargets) {
    void resolveTitle(target.sessionId)
      .then((value) => {
        const display = value ? sanitizeSessionChipTitle(value) : '';
        if (!display || editor.isDestroyed) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'mentionChip') return;
          const attrs = node.attrs as MentionChipAttrs;
          if (attrs.kind !== 'session' || attrs.titled) return;
          if (attrs.path !== path) return;
          tr.setNodeMarkup(pos, undefined, {
            ...attrs,
            label: display,
            titled: true,
          });
          changed = true;
        });
        if (!changed) return;
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      })
      .catch(() => {
        // 解析失败 → 保持短 ID 占位,不打扰用户
      });
  }
}
