import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';

/**
 * GhostConfirmDialogHost —— confirm 槽的 renderer 落地(2026-07-31)。
 *
 * 插件经管子请主机弹确认框(main:confirmSlot → ghostConfirmDialogBridge),这里
 * 把它接到**基座自己在用的那套** ConfirmDialogProvider 上,所以插件的确认框与
 * Cindy 自己的确认框长得一模一样、排队规则也一致(useConfirmDialog 自带队列)。
 *
 * 信任边界(与 Toast 的来源身份头同款):
 * - 标题是**主机文案**(带插件名),插件写不了;
 * - 身份头(图标 + 名字)由这里画,数据来自 main 的已装清单(不是插件自报);
 * - 插件只供 body 与按钮字,main 侧已净化 + 卡长度;这里作纯文本渲染(description
 *   与 content 都是文本节点,不注入 HTML);
 * - 用户的点击才是答案:确认 true、取消/Esc/点外部 false,原样回给 main。
 *
 * main 只把请求投给**单个**窗口,所以收到即本窗口负责弹,不需要按窗口类型 gate
 * ——弹在用户正看着的那个窗口才对。
 *
 * 挂载点:App.tsx 的 ConfirmDialogProvider 内部(要用 context,不能挂在 store 里)。
 */
export function GhostConfirmDialogHost() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    const off = window.electronAPI.ghosts?.onConfirmRequest?.((payload) => {
      if (!payload || typeof payload.requestId !== 'string' || typeof payload.body !== 'string') {
        return;
      }
      const { requestId, ghostName, iconDataUrl, body, confirmText, cancelText, danger } = payload;
      void (async () => {
        let confirmed = false;
        try {
          confirmed = await confirm({
            // 主机文案:插件名只作插值,伪装不了这句话本身
            title: t('settings.ghosts.confirm.dialogTitle', { name: ghostName }),
            description: body,
            // 身份头:与 Toast 的来源头同款视觉(语义 token,明暗两档自动跟随)
            content: (
              <span className="inline-flex items-center gap-1.5">
                {iconDataUrl && (
                  <img
                    src={iconDataUrl}
                    alt=""
                    draggable={false}
                    className="h-4 w-4 rounded-[4px] object-cover"
                  />
                )}
                <span className="max-w-[220px] truncate text-13 font-medium leading-snug text-[var(--text-tertiary)]">
                  {ghostName}
                </span>
              </span>
            ),
            ...(confirmText ? { confirmText } : {}),
            ...(cancelText ? { cancelText } : {}),
            ...(danger ? { confirmVariant: 'destructive' as const } : {}),
          });
        } finally {
          // 无论如何都要回包:不回的话插件那侧会一直挂到 main 的 90 秒兜底超时。
          // 回包失败(窗口正在关等)也不额外处理——那条超时就是为此存在的。
          try {
            await window.electronAPI.ghosts?.resolveConfirm?.(requestId, confirmed);
          } catch {
            // 忽略:main 侧超时会兜底成「没同意」
          }
        }
      })();
    });
    return off;
  }, [confirm, t]);

  return null;
}
