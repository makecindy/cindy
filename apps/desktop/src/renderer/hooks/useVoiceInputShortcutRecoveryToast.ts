/**
 * 「待授权」语音快捷键自动恢复失败时的提示。
 *
 * 触发场景：用户在语音输入设置页**之外**拿到 macOS 监听权限（切走 tab 后才去系统设置里
 * 打开开关），main 侧的兜底恢复据此重新注册，但 helper 仍起不来（二进制缺失、swiftc 失败、
 * 启动超时）。设置页此刻不在，它自己那条 listenerUnavailable toast 也就不在 —— 少了这条
 * 提示，用户被告知「授权后自动生效」之后什么都不会发生，也无处得知为什么。
 *
 * 复用设置页那条文案：故障与成因完全相同（自带「重启 Cindy 再试」的下一步），两处给不同
 * 说法只会让人以为是两种问题。
 *
 * 为什么挂载时要主动 consume 一次、而不是只听推送：恢复可能发生在本组件挂载之前（登录门、
 * 数据库门还在前面），那时 fan-out 没有订阅者，推送就没了。状态留在 main、被取走才清，
 * 所以两条路都指向同一个 consume —— 取到才提示，重复取只会得到 false，不会弹第二次。
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';

const log = createLogger('useVoiceInputShortcutRecoveryToast');

export function useVoiceInputShortcutRecoveryToast(): void {
  const { t } = useTranslation();
  useEffect(() => {
    let cancelled = false;
    const showIfPending = async (): Promise<void> => {
      try {
        const result = await window.electronAPI.voiceInput.consumeShortcutRecoveryFailure();
        if (cancelled || !result.failed) return;
        toast.error(t('settings.voiceInput.shortcut.toast.listenerUnavailable'), { duration: 10000 });
      } catch (error) {
        // 取不到不额外打扰用户：设置页里的徽章与行内说明仍然摆着状态和入口。
        log.warn('failed to consume voice input shortcut recovery failure:', error);
      }
    };
    void showIfPending();
    const unsubscribe = window.electronAPI.voiceInput.onShortcutRecoveryFailed(() => {
      void showIfPending();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [t]);
}
