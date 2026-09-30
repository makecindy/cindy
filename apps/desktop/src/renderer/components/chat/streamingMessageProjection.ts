import type { ChatMessage } from '@/lib/makerChatStore';
import { groupWorkRuns, isCompletedAssistantMessage, type RenderItem } from './messageWorkGroups';

export interface MessageRenderProjection {
  items: RenderItem[];
  singleResultMap: Map<string, string>;
}

function sameFieldsExcept<T extends object>(previous: T, next: T, ignored: keyof T): boolean {
  const keys = Object.keys(previous) as (keyof T)[];
  return (
    keys.length === Object.keys(next).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(next, key) &&
        (key === ignored || Object.is(previous[key], next[key])),
    )
  );
}

/** Only a nonempty, plain streaming answer may bypass content-dependent history work. */
export function isStreamingTextOnlyUpdate(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[],
): boolean {
  if (previous === next) return true;
  if (previous.length === 0 || previous.length !== next.length) return false;
  const last = next.length - 1;
  const before = previous[last];
  const after = next[last];
  if (
    before.role !== 'assistant' ||
    before.systemCardType ||
    before.isStreaming !== true ||
    after.isStreaming !== true ||
    !before.content.trim() ||
    !after.content.trim() ||
    !sameFieldsExcept(before, after, 'content')
  )
    return false;
  for (let index = 0; index < last; index++) if (previous[index] !== next[index]) return false;
  return true;
}

/** For metadata-only consumers. Never use this snapshot to display or copy answer text. */
export function createMessageMetadataProjection() {
  let previous: ChatMessage[] | undefined;
  return (messages: ChatMessage[]): ChatMessage[] => {
    if (!previous || !isStreamingTextOnlyUpdate(previous, messages)) previous = messages;
    return previous;
  };
}

/** Metadata-only render-item consumers (gallery membership and user navigation).
 * Never feed this snapshot to text rendering, copy, search or answer previews.
 */
export function createRenderItemMetadataProjection() {
  let previous: RenderItem[] | undefined;
  return (items: RenderItem[]): RenderItem[] => {
    const unchanged =
      previous &&
      previous.length === items.length &&
      items.every((item, index) => {
        const before = previous![index];
        return (
          item === before ||
          (index === items.length - 1 &&
            item.type === 'message' &&
            before.type === 'message' &&
            item.key === before.key &&
            isStreamingTextOnlyUpdate([before.message], [item.message]))
        );
      });
    if (!unchanged) previous = items;
    return previous!;
  };
}

/** A view owns this projection; no session data survives its unmount. */
export function createStreamingMessageProjection() {
  let previous:
    | { messages: ChatMessage[]; dependencies: readonly unknown[]; result: MessageRenderProjection }
    | undefined;
  return (
    messages: ChatMessage[],
    dependencies: readonly unknown[],
    build: () => MessageRenderProjection,
    allowTextReuse = true,
  ): MessageRenderProjection => {
    let result: MessageRenderProjection | undefined;
    if (
      allowTextReuse &&
      previous &&
      previous.dependencies.length === dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous!.dependencies[index]))
    ) {
      if (previous.messages === messages) return previous.result;
      if (isStreamingTextOnlyUpdate(previous.messages, messages)) {
        const before = previous.messages[previous.messages.length - 1];
        const after = messages[messages.length - 1];
        const index = previous.result.items.findIndex(
          (item) => item.type === 'message' && item.message === before,
        );
        // Hidden/subagent rows and special projections must still go through the full builder.
        if (index >= 0) {
          const items = previous.result.items.slice();
          items[index] = { type: 'message', key: items[index].key, message: after };
          result = { items, singleResultMap: previous.result.singleResultMap };
        }
      }
    }
    result ??= build();
    previous = { messages, dependencies: [...dependencies], result };
    return result;
  };
}

/** Preserve unchanged work groups between successive projections of one view. */
export function createWorkGroupProjection() {
  let previous = new Map<string, Extract<RenderItem, { type: 'work_group' }>>();
  return (items: RenderItem[]): RenderItem[] => {
    const next = new Map<string, Extract<RenderItem, { type: 'work_group' }>>();
    const reuse = (item: RenderItem): RenderItem => {
      if (item.type !== 'work_group') return item;
      const children = item.children.map((child) => reuse(child) as typeof child);
      const old = previous.get(item.key);
      const unchanged =
        old &&
        sameFieldsExcept(old, item, 'children') &&
        old.children.length === children.length &&
        children.every((child, index) => child === old.children[index]);
      const result = unchanged ? old : { ...item, children };
      next.set(item.key, result);
      return result;
    };
    const result = items.map(reuse);
    previous = next; // Drop removed/prepended-away groups; this is not an unbounded key cache.
    return result;
  };
}

/**
 * Plain active-tail text cannot change the activity runs before it. Reuse the
 * already grouped history instead of rebuilding timestamps and nested wrappers.
 * Only the last standalone, unsealed answer qualifies: earlier answers can cross
 * delivery-prose thresholds and change which completed groups remain visible.
 */
export function createStreamingWorkGroupProjection(group = groupWorkRuns) {
  const reuseGroups = createWorkGroupProjection();
  let previous:
    | { items: RenderItem[]; streaming: boolean; alreadyGrouped: boolean; result: RenderItem[] }
    | undefined;
  return (items: RenderItem[], streaming: boolean, alreadyGrouped = false): RenderItem[] => {
    let result: RenderItem[] | undefined;
    if (
      previous &&
      previous.streaming === streaming &&
      previous.alreadyGrouped === alreadyGrouped
    ) {
      if (previous.items === items) return previous.result;
      const before = previous.items.at(-1);
      const after = items.at(-1);
      if (
        streaming &&
        !alreadyGrouped &&
        before?.type === 'message' &&
        after?.type === 'message' &&
        before.key === after.key &&
        !isCompletedAssistantMessage(before.message) &&
        isStreamingTextOnlyUpdate([before.message], [after.message]) &&
        previous.items.length === items.length &&
        previous.result.at(-1) === before &&
        items.every((item, index) => index === items.length - 1 || item === previous!.items[index])
      ) {
        result = previous.result.slice();
        result[result.length - 1] = after;
      }
    }
    result ??= reuseGroups(alreadyGrouped ? items : group(items, streaming));
    previous = { items, streaming, alreadyGrouped, result };
    return result;
  };
}
