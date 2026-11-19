import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { ChatBubble } from '@/components/chat/ChatBubble';
import { ComposerCard } from '@/components/new-chat/ComposerCard';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsRow } from '@/components/ui/settings-rows';
import { Slider } from '@/components/ui/slider';
import { CHAT_WIDTH_PERCENT, useChatLayoutPreference } from '@/hooks/useChatLayoutPreference';
import { getChatColumnWidths, STANDARD_CHAT_MESSAGE_WIDTH } from '@/hooks/useProportionalWidth';

import { appearanceSettings } from './AppearanceSection.settings-search';

function ChatLayoutPreview({ width }: { width: number }) {
  // Scale a wide chat pane so the setting remains demonstrable in a small window.
  const paneWidth = 1600;
  const { messageWidth, inputWidth } = getChatColumnWidths(paneWidth, STANDARD_CHAT_MESSAGE_WIDTH, width);
  return (
    <div aria-hidden="true" className="w-24 shrink-0 rounded-xl border border-border bg-content-area py-1">
      <div
        className="mx-auto flex flex-col gap-1"
        style={{ width: `${messageWidth / paneWidth * 100}%` }}
        data-testid="chat-layout-preview-column"
      >
        <ChatBubble speaker="user" className="ml-auto flex w-[30%] items-center justify-center px-1 py-0.5">
          <span className="h-px w-full rounded-full bg-current opacity-25" />
        </ChatBubble>
        <ChatBubble bare className="flex flex-col gap-0.5">
          <span className="h-px w-full rounded-full bg-current opacity-20" />
          <span className="h-px w-3/5 rounded-full bg-current opacity-20" />
        </ChatBubble>
      </div>
      <ComposerCard
        className="mx-auto mt-1 flex h-3 items-center justify-between rounded px-1"
        style={{ width: `${inputWidth / paneWidth * 100}%` }}
      >
        <span className="h-px w-1/5 rounded-full bg-[var(--text-tertiary)] opacity-30" />
        <span className="size-1 rounded-full bg-[var(--text-secondary)]" />
      </ComposerCard>
    </div>
  );
}

export function ChatLayoutSettings() {
  const { t } = useTranslation();
  const { mode, width, setMode, setWidth, preview } = useChatLayoutPreference();
  const layout = appearanceSettings.chatLayout;
  const contentWidth = appearanceSettings.chatWidth;
  const hintId = `${contentWidth.targetId}-hint`;
  const displayWidth = `${width}%`;

  // Slider restores the initial drag value on cancel. Use the latest saved value afterward.
  const cancelPreview = useCallback(() => queueMicrotask(() => preview(null)), [preview]);
  useEffect(() => {
    window.addEventListener('blur', cancelPreview);
    return () => {
      window.removeEventListener('blur', cancelPreview);
      preview(null);
    };
  }, [cancelPreview, preview]);

  return (
    <>
      <SettingsRow
        id={appearanceSettings.chatLayout.targetId}
        className="cindy-segmented-row"
        wrap
        title={t(layout.titleKey)}
        trailing={
          <SegmentedControl
            data-setting-id={layout.id}
            aria-label={t(layout.titleKey)}
            value={mode}
            onValueChange={setMode}
            options={layout.options.map(({ value, labelKey }) => ({ value, label: t(labelKey) }))}
          />
        }
      />
      {mode === 'wide' && (
        <SettingsRow
          id={appearanceSettings.chatWidth.targetId}
          wrap
          title={<span id={`${contentWidth.targetId}-label`}>{t(contentWidth.titleKey)}</span>}
          hint={<span id={hintId}>{t(contentWidth.descriptionKey)}</span>}
          trailing={
            <div className="flex w-full max-w-[320px] items-center gap-3">
              <Slider
                data-setting-id={contentWidth.id}
                aria-labelledby={`${contentWidth.targetId}-label`}
                aria-describedby={hintId}
                aria-valuetext={displayWidth}
                min={CHAT_WIDTH_PERCENT.min}
                max={CHAT_WIDTH_PERCENT.max}
                step={CHAT_WIDTH_PERCENT.step}
                value={[width]}
                onValueChange={([value]) => preview(value)}
                onValueCommit={([value]) => setWidth(value)}
                onPointerCancel={cancelPreview}
                onLostPointerCapture={cancelPreview}
              />
              <span className="w-10 shrink-0 text-right text-13 tabular-nums text-[var(--settings-section-sublabel)]">{displayWidth}</span>
              <ChatLayoutPreview width={width} />
            </div>
          }
        />
      )}
    </>
  );
}
