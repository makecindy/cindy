/**
 * 自定义插件市场指南对话框：从「添加插件市场」里的「了解更多」进入。
 *
 * 内容覆盖用户搭建/添加一个市场所需的全部事实：目录结构与清单位置、
 * marketplace.json 格式、来源与稀疏路径用法、私有仓库认证（系统 Git 配置）、
 * 安装规则。文案全部走 i18n；代码块内容（结构树 / JSON 示例）不翻译。
 */
import type { CSSProperties, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * 目录结构示例。路径本身不翻译，箭头后的解释性标签必须跟随界面语言 —— 否则
 * 英/日/韩界面下展示与复制出来的内容里会夹着中文标签。路径列宽固定，标签长度
 * 变化不影响箭头对齐。
 */
function structureExample(label: (key: string) => string): string {
  return `my-marketplace/
├── .agents/plugins/marketplace.json   ← ${label('structureLabelManifest')}
└── plugins/
    └── my-plugin/
        ├── ghost.json                 ← ${label('structureLabelGhostCard')}
        └── main.js                    ← ${label('structureLabelEntry')}`;
}

const MANIFEST_PATHS_EXAMPLE = `.agents/plugins/marketplace.json
.agents/plugins/api_marketplace.json
.claude-plugin/marketplace.json
.cursor-plugin/marketplace.json`;

const MANIFEST_EXAMPLE = `{
  "name": "my-marketplace",
  "plugins": [
    { "name": "my-plugin", "source": "plugins/my-plugin" }
  ]
}`;

export interface MarketplaceGuideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function GuideSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-5 first:mt-0">
      <h3 className="text-13 font-medium text-[var(--text-primary)]">{title}</h3>
      <div className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">{children}</div>
    </section>
  );
}

function GuideCode({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-xl bg-[var(--surface-chip)] px-3.5 py-3 font-mono text-11 leading-4 text-[var(--text-secondary)]">
      {children}
    </pre>
  );
}

export function MarketplaceGuideDialog({ open, onOpenChange }: MarketplaceGuideDialogProps) {
  const { t } = useTranslation();
  const guideKey = (key: string) => t(`settings.ghosts.market.sources.guide.${key}`);
  // 展示与复制共用同一份已本地化的结构树,两处内容必须一致。
  const structure = structureExample(guideKey);

  /** 把整份指南按纯文本组装进剪贴板，结构树与 JSON 示例原样带上。 */
  const copyGuide = async () => {
    const text = [
      guideKey('title'),
      '',
      guideKey('intro'),
      '',
      `## ${guideKey('structureTitle')}`,
      guideKey('structureBody'),
      '',
      structure,
      '',
      guideKey('structureNote'),
      '',
      MANIFEST_PATHS_EXAMPLE,
      '',
      `## ${guideKey('manifestTitle')}`,
      guideKey('manifestBody'),
      '',
      MANIFEST_EXAMPLE,
      '',
      `## ${guideKey('sourceTitle')}`,
      guideKey('sourceBody'),
      '',
      `## ${guideKey('authTitle')}`,
      guideKey('authBody'),
      '',
      `## ${guideKey('rulesTitle')}`,
      guideKey('rulesBody'),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('settings.ghosts.market.sources.guide.copied'));
    } catch {
      toast.error(t('settings.ghosts.market.sources.guide.copyFailed'));
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[10001] bg-[var(--overlay-modal)]',
            'data-[state=open]:animate-confirm-overlay-in',
            'data-[state=closed]:animate-confirm-overlay-out',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[85vh] w-full select-none flex-col rounded-xl p-4',
            'bg-[var(--confirm-bg)] shadow-[var(--confirm-shadow)]',
            'data-[state=open]:animate-confirm-content-in',
            'data-[state=closed]:animate-confirm-content-out',
          )}
          style={
            {
              WebkitAppRegion: 'no-drag',
              maxWidth: 'min(560px, 100vw - 32px)',
            } as CSSProperties
          }
        >
          <div className="flex shrink-0 items-start justify-between gap-3">
            <Dialog.Title className="text-lg font-medium text-[var(--confirm-title)]">
              {t('settings.ghosts.market.sources.guide.title')}
            </Dialog.Title>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => void copyGuide()}
                aria-label={t('settings.ghosts.market.sources.guide.copy')}
                className="inline-flex size-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <Copy size={14} aria-hidden="true" />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('settings.ghosts.market.sources.close')}
                  className="inline-flex size-7 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
          </div>
          <Dialog.Description className="mt-2 shrink-0 text-13 text-[var(--confirm-desc)]">
            {t('settings.ghosts.market.sources.guide.intro')}
          </Dialog.Description>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
            <GuideSection title={t('settings.ghosts.market.sources.guide.structureTitle')}>
              <p>{t('settings.ghosts.market.sources.guide.structureBody')}</p>
              <GuideCode>{structure}</GuideCode>
              <p className="mt-2">{t('settings.ghosts.market.sources.guide.structureNote')}</p>
              <GuideCode>{MANIFEST_PATHS_EXAMPLE}</GuideCode>
            </GuideSection>

            <GuideSection title={t('settings.ghosts.market.sources.guide.manifestTitle')}>
              <p>{t('settings.ghosts.market.sources.guide.manifestBody')}</p>
              <GuideCode>{MANIFEST_EXAMPLE}</GuideCode>
            </GuideSection>

            <GuideSection title={t('settings.ghosts.market.sources.guide.sourceTitle')}>
              <p>{t('settings.ghosts.market.sources.guide.sourceBody')}</p>
            </GuideSection>

            <GuideSection title={t('settings.ghosts.market.sources.guide.authTitle')}>
              <p>{t('settings.ghosts.market.sources.guide.authBody')}</p>
            </GuideSection>

            <GuideSection title={t('settings.ghosts.market.sources.guide.rulesTitle')}>
              <p>{t('settings.ghosts.market.sources.guide.rulesBody')}</p>
            </GuideSection>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
