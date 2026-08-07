import type { TFunction } from 'i18next';

import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { getSessionRouteOwnerId, resolveSessionRoute } from '@/lib/orcaSessionIdentity';

const log = createLogger('NavigationCommands');
const SLASH_COMMAND_REGEX = /^\/(\S+)(?:\s+(.*))?$/s;

export const NAVIGATION_COMMAND_NAMES = new Set(['jump-session']);

/**
 * 同步判断 message 是否是某个本地导航命令(给"新建界面"的同步 handleSend 入口用,
 * 以便在进入 createSession 前就短路)。命中返回命令名,否则 null。正则只此一处定义。
 */
export function matchNavigationCommandName(message: string): string | null {
  const name = message.match(SLASH_COMMAND_REGEX)?.[1]?.toLowerCase();
  return name && NAVIGATION_COMMAND_NAMES.has(name) ? name : null;
}

export async function tryHandleNavigationCommand(
  message: string,
  deps: {
    navigate: (to: string) => void;
    t: TFunction;
    /** sidebar-embedded 内容视图消费命令但不解析/改变窗口路由。 */
    allowNavigation?: boolean;
    /** split-pane 在改变窗口路由前报告来源 pane 的替换意图。 */
    onSessionNavigate?: (targetSessionId: string, routeOwnerSessionId?: string) => void;
    /** split-pane 来源 pane 卸载或切换后使仍在途的异步导航失效。 */
    isNavigationCurrent?: () => boolean;
  },
): Promise<boolean> {
  const slashMatch = message.match(SLASH_COMMAND_REGEX);
  if (!slashMatch) return false;

  const commandName = slashMatch[1].toLowerCase();
  if (!NAVIGATION_COMMAND_NAMES.has(commandName)) return false;
  if (deps.allowNavigation === false) {
    log.info('[jump-session] navigation ignored by embedded session view');
    return true;
  }
  if (deps.isNavigationCurrent && !deps.isNavigationCurrent()) return true;

  const sessionId = (slashMatch[2] ?? '').trim();
  if (!sessionId) {
    toast.error(deps.t('ccAgent.jumpSession.emptyId'));
    return true;
  }

  try {
    const session = await sessionService.get(sessionId);
    if (deps.isNavigationCurrent && !deps.isNavigationCurrent()) return true;
    if (!session || session.status === 'deleted') {
      toast.error(deps.t('ccAgent.jumpSession.notFound'));
      return true;
    }
    const route = await resolveSessionRoute(sessionId, session);
    if (deps.isNavigationCurrent && !deps.isNavigationCurrent()) return true;
    deps.onSessionNavigate?.(sessionId, getSessionRouteOwnerId(route) ?? sessionId);
    deps.navigate(route);
  } catch (err) {
    if (deps.isNavigationCurrent && !deps.isNavigationCurrent()) return true;
    log.warn('[jump-session] navigation target resolution failed', {
      sessionId,
      error: String(err),
    });
    toast.error(deps.t('ccAgent.jumpSession.notFound'));
    return true;
  }
  return true;
}
