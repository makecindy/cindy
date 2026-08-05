/**
 * Claude Auto 权限分类器故障降级的用户提示。
 *
 * 本机 main push 与 device-link 被控端转发使用同一 payload；renderer 只展示一次
 * warning，权限 selector 的真实状态由 `local-db:sessions:patched` 单独收敛。
 */

import { i18n } from '@/i18n';

import { toast } from './toast';

export interface AutoPermissionFallbackPayload {
  sessionId: string;
  from: 'auto';
  to: 'ask';
  reason: 'classifier_unavailable';
  status: number;
}

function isAutoPermissionFallbackPayload(value: unknown): value is AutoPermissionFallbackPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<AutoPermissionFallbackPayload>;
  return (
    typeof payload.sessionId === 'string' &&
    payload.from === 'auto' &&
    payload.to === 'ask' &&
    payload.reason === 'classifier_unavailable' &&
    typeof payload.status === 'number'
  );
}

/** exported for unit tests；正常入口由 installAutoPermissionFallbackToastListener 安装。 */
export function handleAutoPermissionFallback(): void {
  toast.warning(i18n.t('newChat.permissionSelector.autoFallback'));
}

/** 同时订阅本机与被控端 push；返回统一 unsubscribe。 */
export function installAutoPermissionFallbackToastListener(): () => void {
  const offLocal = window.electronAPI.maker.onAutoPermissionFallback(handleAutoPermissionFallback);
  const offRemote = window.electronAPI.deviceLink?.onRemotePush?.((push) => {
    if (
      push.channel === 'maker:auto-permission:fallback' &&
      isAutoPermissionFallbackPayload(push.payload)
    ) {
      handleAutoPermissionFallback();
    }
  });
  return () => {
    offLocal();
    offRemote?.();
  };
}
