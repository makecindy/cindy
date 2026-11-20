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
