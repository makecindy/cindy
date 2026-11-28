// The split tree and the native window drag carry an opaque string. Task IDs
// keep their existing representation; companion entries carry their chat path.
export function companionChatTarget(pathname: string, search = ''): string | null {
  if (!pathname.startsWith('/bots/')) return null;
  // Accept encoded IDs, but never a traversal or a non-chat destination.
  try {
    if (
      pathname.split('/').some((segment) => {
        const id = decodeURIComponent(segment);
        return id === '.' || id === '..' || id.includes('\\');
      })
    )
      return null;
  } catch {
    return null;
  }
  const match =
    /^\/(bots\/(?:groups\/[^/?#]+|remote\/[^/?#]+\/[^/?#]+|[^/?#]+))(?:\/session\/[^/?#]+)?$/.exec(
      pathname,
    );
  if (!match || /[\\\s]/.test(pathname)) return null;
  const path = '/' + match[1];
  if (['/bots/list', '/bots/roster', '/bots/market', '/bots/groups', '/bots/remote'].includes(path))
    return null;
  if (path.startsWith('/bots/groups/')) {
    if (path !== pathname) return null;
    return new URLSearchParams(search).get('conversationKind') === 'direct'
      ? path + '?conversationKind=direct'
      : path;
  }
  return path;
}

export function isCompanionChatTarget(target: string): boolean {
  const [path, search] = target.split('?');
  return companionChatTarget(path, search) === target;
}

const GROUP_MESSAGE_UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Validated route for opening a companion chat or group thread reply in a
 * secondary window. Extends `companionChatTarget` with group message jump
 * parameters (`messageId`, optional `threadRootId`) while rejecting unknown
 * query keys so split-pane identities stay unaffected.
 */
export function companionWindowBootRoute(target: string): string | null {
  const queryIndex = target.indexOf('?');
  const pathname = queryIndex >= 0 ? target.slice(0, queryIndex) : target;
  const search = queryIndex >= 0 ? target.slice(queryIndex + 1) : '';
  const base = companionChatTarget(pathname, search);
  if (!base) return null;
  if (!search) return base;

  const incoming = new URLSearchParams(search);
  const [basePath, baseSearch = ''] = base.split('?');
  if (!basePath.startsWith('/bots/groups/')) return null;

  const out = new URLSearchParams(baseSearch);
  const messageId = incoming.get('messageId');
  const threadRootId = incoming.get('threadRootId');
  for (const key of incoming.keys()) {
    if (key !== 'conversationKind' && key !== 'messageId' && key !== 'threadRootId') {
      return null;
    }
  }
  if (incoming.has('conversationKind') && incoming.get('conversationKind') !== 'direct') {
    return null;
  }
  if (threadRootId !== null && !messageId) return null;
  if (messageId !== null) {
    if (!GROUP_MESSAGE_UUID_RE.test(messageId)) return null;
    out.set('messageId', messageId);
  }
  if (threadRootId !== null) {
    if (!GROUP_MESSAGE_UUID_RE.test(threadRootId)) return null;
    out.set('threadRootId', threadRootId);
  }
  const serialized = out.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}
