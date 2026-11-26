import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { useCallback, useRef, useState } from 'react';
import { useDialogExit } from '@/hooks/useDialogExit';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
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
import { FieldVoiceInputNotice } from '@/voice-input/FieldVoiceInputNotice';
import { useFieldVoiceInput } from '@/voice-input/useFieldVoiceInput';
import { VoiceInputButton } from '@/voice-input/VoiceInputButton';

/** 吞掉卡片外的点击。锚定在卡片上的输入浮层保持透明;居中的确认框是模态弹窗,用统一遮罩(DESIGN §4)。 */
function BlockingScrim({ modal = false }: { modal?: boolean }) {
  return (
    <div
      className={modal ? 'modal-scrim fixed inset-0 z-modal' : 'fixed inset-0 z-page-top'}
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
  onSubmit: (overrideText?: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const submittingVoiceRef = useRef(false);
  const [stoppingVoice, setStoppingVoice] = useState(false);

  const voice = useFieldVoiceInput({
    draftKey: 'ghost-card-prompt',
    inputRef: textareaRef,
    value: text,
    onChange: (next) => onTextChange(next),
    maxLength: GHOST_CARD_ACTION_PROMPT_MAX_LEN,
  });

  const canSend = !!voice.displayText.trim() && !stoppingVoice;

  const handleSubmit = useCallback(async () => {
    if (!canSend || submittingVoiceRef.current) return;
    if (voice.isBusy) {
      submittingVoiceRef.current = true;
      setStoppingVoice(true);
      let finalText = text;
      try {
        finalText = await voice.stop();
      } finally {
        submittingVoiceRef.current = false;
        setStoppingVoice(false);
      }
      if (!finalText.trim()) return;
      onSubmit(finalText);
      return;
    }
    onSubmit();
  }, [canSend, onSubmit, text, voice.isBusy, voice.stop]);

  return (
    <>
      <BlockingScrim />
      <div
        className="absolute z-50 w-72 rounded-xl border p-2"
        style={{
          top,
          left,
          backgroundColor: 'var(--surface-elevated)',
          borderColor: 'var(--border-default)',
          boxShadow: 'var(--shadow-menu)',
        }}
      >
        <div
          className="flex flex-col rounded-lg border"
          style={{
            backgroundColor: 'var(--msg-tool-card-bg)',
            borderColor: 'var(--msg-tool-card-border)',
          }}
        >
          <ListComposerTextarea
            ref={textareaRef}
            autoFocus
            rows={2}
            value={voice.displayText}
            readOnly={voice.isBusy}
            maxLength={GHOST_CARD_ACTION_PROMPT_MAX_LEN}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={(e) => {
              // 中文输入法组词中的 Enter 不能触发发送(同老基座)。
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              } else if (e.key === 'Escape') {
                if (voice.isBusy) return;
                onCancel();
              }
            }}
            placeholder={placeholder || t('chat.mivoAction.promptPlaceholder')}
            className="w-full resize-none bg-transparent px-2 pt-1.5 pb-1 text-xs outline-none placeholder:text-[var(--text-placeholder)]"
            style={{ color: 'var(--msg-tool-card-text)' }}
          />
          <div className="flex items-center justify-end px-1.5 pb-1.5 pt-0.5">
            <VoiceInputButton {...voice.buttonProps} testId="ghost-card-prompt-voice" tipSide="top" />
          </div>
        </div>
        <FieldVoiceInputNotice
          error={voice.lastError}
          speakerFiltered={voice.speakerFiltered}
          className="mt-1.5"
        />
        <div className="mt-1.5 flex items-center justify-end gap-1.5">
          <Button variant="secondary" tone="quiet" size="xs" compact onClick={onCancel} disabled={stoppingVoice}>
            {t('chat.mivoAction.promptCancel')}
          </Button>
          <Button
            variant="secondary"
            size="xs"
            compact
            loading={stoppingVoice}
            onClick={() => void handleSubmit()}
            disabled={!canSend}
          >
            {t('chat.mivoAction.promptSend')}
          </Button>
        </div>
      </div>
    </>
  );
}

export function GhostCardLinkConfirm({
  url,
  host,
  onConfirm: notifyConfirmed,
  onCancel: notifyCanceled,
}: {
  url: string;
  /** 醒目域名;解析失败传空串,正文仍展示全串。 */
  host: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useDialogExit();
  const onCancel = useCallback(() => dialog.close(notifyCanceled), [dialog.close, notifyCanceled]);
  const onConfirm = useCallback(() => dialog.close(notifyConfirmed), [dialog.close, notifyConfirmed]);
  return (
    <AlertDialog.Root open={dialog.open} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className="modal-scrim fixed inset-0 z-modal"
          style={WINDOW_DRAG_STYLE}
          data-testid="ghost-card-scrim"
          onMouseDown={(event) => event.preventDefault()}
        />
      <AlertDialog.Content
        className="modal-panel fixed inset-0 z-modal-raised m-auto h-fit w-80 p-3.5 outline-none"
        style={WINDOW_NO_DRAG_STYLE}
        onOpenAutoFocus={dialog.onOpenAutoFocus}
        onCloseAutoFocus={dialog.onCloseAutoFocus}
      >
        <AlertDialog.Title asChild><div className="text-13 font-medium" style={{ color: 'var(--text-primary)' }}>
          {t('chat.ghostCall.linkConfirmTitle')}
        </div></AlertDialog.Title>
        <AlertDialog.Description asChild><div className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {t('chat.ghostCall.linkConfirmHint')}
        </div></AlertDialog.Description>
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
          <AlertDialog.Cancel asChild><Button
            variant="secondary"
            tone="quiet"
            size="xs"
            compact
            type="button"
          >
            {t('chat.ghostCall.linkConfirmCancel')}
          </Button></AlertDialog.Cancel>
          <Button variant="secondary" size="xs" compact type="button" onClick={onConfirm}>
            {t('chat.ghostCall.linkConfirmOpen')}
          </Button>
        </div>
      </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
