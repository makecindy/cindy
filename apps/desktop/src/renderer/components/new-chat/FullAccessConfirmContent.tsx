/**
 * Full access 升级确认弹窗的富内容区(ChatInput 切换权限档时经 useConfirmDialog 弹出)。
 *
 * 把原先一整段权限说明拆成逐类可扫读的清单(文件 / 终端命令 / 网络),行结构与
 * 与插件详情页的能力清单同构；标题/说明的
 * 文字色阶改用 --text-primary / --text-secondary(原因见行内注释)。文案在
 * newChat.chatInput.fullAccessConfirmation.*,此处只负责排版。
 */
import { FolderOpen, Globe, Terminal, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

const ITEMS: Array<{ key: 'files' | 'commands' | 'network'; icon: LucideIcon }> = [
  { key: 'files', icon: FolderOpen },
  { key: 'commands', icon: Terminal },
  { key: 'network', icon: Globe },
];

export function FullAccessConfirmContent() {
  const { t } = useTranslation();
  return (
    <div>
      <div className="rounded-xl border border-[var(--border-default)]">
        {ITEMS.map(({ key, icon: Icon }, index) => (
          <div
            key={key}
            className={cn(
              'flex items-start gap-2.5 px-3 py-2.5',
              index > 0 && 'border-t border-[var(--border-default)]',
            )}
          >
            <Icon
              size={16}
              className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <div className="min-w-0">
              {/* 标题/说明用 --text-primary / --text-secondary:两档在明暗两模式都有
                  色阶差。不沿用插件详情的 --confirm-desc / --text-tertiary
                  —— 那对 token 在 Dark 下同为 #737373,两级层级会塌成同色,
                  只剩字号差(2026-08 产品门 review 定的取舍)。 */}
              <p className="break-words text-13 font-medium leading-5 text-[var(--text-primary)]">
                {t(`newChat.chatInput.fullAccessConfirmation.items.${key}.title`)}
              </p>
              <p className="break-words text-12 leading-[1.5] text-[var(--text-secondary)]">
                {t(`newChat.chatInput.fullAccessConfirmation.items.${key}.description`)}
              </p>
            </div>
          </div>
        ))}
      </div>
      {/* 兜底边界的宽心话:内置高风险操作仍会确认。作为脚注而非清单项 ——
          它不是"将被放开"的权限,混进清单会削弱上面三条的警示语义。 */}
      <p className="mt-3 text-12 leading-[1.5] text-[var(--text-tertiary)]">
        {t('newChat.chatInput.fullAccessConfirmation.note')}
      </p>
    </div>
  );
}
