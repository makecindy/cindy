/**
 * 插件卡片(GhostToolCard)的两个宿主交互面:
 *   - GhostCardPromptPanel:data-ghost-prompt 动作的提示词输入面板(与老基座
 *     ChatImageActions 的 imgPrompt popover 同体验:textarea + 回车发送/Esc 取消),
 *     锚在被点按钮下方;
 *   - GhostCardLinkConfirm:data-ghost-link 外链确认框,域名醒目 + 完整链接全量
 *     展示——卡内文案归意识,真实去向由宿主如实亮给用户,确认才 openExternal。
 *
 * 两者都按 DESIGN.md 关闭规则点外部不关闭(免得误点丢掉已输入的提示词):遮罩只
 * 拦截点击,并 preventDefault 保住焦点,让回车 / Esc 仍有效。
 */
import { Button } from '@/components/ui/button';
import { ListComposerTextarea } from '@/components/new-chat/ListComposerTextarea';
import { useTranslation } from 'react-i18next';

import { GHOST_CARD_ACTION_PROMPT_MAX_LEN } from '@/../shared/ghost';

function BlockingScrim() {
  return (
    <div
      className="fixed inset-0 z-40"
      data-testid="ghost-card-scrim"
      onMouseDown={(e) => e.preventDefault()}
    />
  );
}

export function GhostCardPromptPanel({
  top,
  left,
  placeholder,
  text,
  onTextChange,
  onSubmit,
  onCancel,
}: {
  top: number;
  left: number;
  placeholder: string;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const canSend = !!text.trim();
  return (
    <>
      <BlockingScrim />
      <div
        className="absolute z-50 w-72 rounded-md border p-2"
        style={{
          top,
          left,
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-default)',
          boxShadow: 'var(--shadow-menu)',
        }}
      >
        <ListComposerTextarea
          autoFocus
          rows={3}
          value={text}
          maxLength={GHOST_CARD_ACTION_PROMPT_MAX_LEN}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            // 中文输入法组词中的 Enter 不能触发发送(同老基座)。
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          placeholder={placeholder || t('chat.mivoAction.promptPlaceholder')}
          className="w-full resize-none rounded-md border px-2 py-1.5 text-xs outline-none placeholder:text-[var(--text-tertiary)]"
          style={{
            backgroundColor: 'var(--msg-tool-card-bg)',
            borderColor: 'var(--msg-tool-card-border)',
            color: 'var(--msg-tool-card-text)',
          }}
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-6 cursor-pointer rounded-md px-2 text-xs transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            {t('chat.mivoAction.promptCancel')}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            className={
              'h-6 rounded-md border px-2.5 text-xs font-medium transition-colors ' +
              (canSend
                ? 'cursor-pointer hover:bg-[var(--msg-table-header-bg)]'
                : 'cursor-not-allowed opacity-40')
            }
            style={{
              backgroundColor: 'var(--msg-tool-card-bg)',
              borderColor: 'var(--msg-tool-card-border)',
              color: 'var(--msg-tool-card-text)',
            }}
          >
            {t('chat.mivoAction.promptSend')}
          </button>
        </div>
      </div>
    </>
  );
}

export function GhostCardLinkConfirm({
  url,
  host,
  onConfirm,
  onCancel,
}: {
  url: string;
  /** 醒目域名;解析失败传空串,正文仍展示全串。 */
  host: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <BlockingScrim />
      <div
        className="fixed left-1/2 top-1/2 z-50 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg border p-3.5"
        role="alertdialog"
        aria-label={t('chat.ghostCall.linkConfirmTitle')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        style={{
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-default)',
          boxShadow: 'var(--shadow-menu)',
        }}
      >
        <div className="text-13 font-semibold" style={{ color: 'var(--text-primary)' }}>
          {t('chat.ghostCall.linkConfirmTitle')}
        </div>
        <div className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {t('chat.ghostCall.linkConfirmHint')}
        </div>
        {host ? (
          <div
            className="mt-1.5 break-all text-13 font-semibold"
            style={{ color: 'var(--text-primary)' }}
          >
            {host}
          </div>
        ) : null}
        <div
          className="mt-1 max-h-24 overflow-y-auto break-all font-mono text-11 leading-relaxed"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {url}
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-1.5">
          <Button
            variant="secondary"
            tone="quiet"
            size="xs"
            compact
            type="button"
            autoFocus
            onClick={onCancel}
          >
            {t('chat.ghostCall.linkConfirmCancel')}
          </Button>
          <Button variant="secondary" size="xs" compact type="button" onClick={onConfirm}>
            {t('chat.ghostCall.linkConfirmOpen')}
          </Button>
        </div>
      </div>
    </>
  );
}
