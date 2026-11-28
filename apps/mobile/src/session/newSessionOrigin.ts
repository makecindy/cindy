/** 新建任务页的来源：应用内入口，或 Android 桌面「Cindy 任务」组件。 */
export type NewSessionOrigin = 'app' | 'widget';

export const NEW_SESSION_ORIGIN_PARAM = 'newSessionOrigin';
export const WIDGET_NEW_SESSION_ORIGIN = 'widget';

export function readNewSessionOrigin(
  value: string | string[] | undefined | null,
): NewSessionOrigin {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === WIDGET_NEW_SESSION_ORIGIN ? 'widget' : 'app';
}
