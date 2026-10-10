import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Bot } from 'lucide-react';
import { acknowledgeBotAiDisclosure, isBotAiDisclosureAcknowledged } from './botAiDisclosure';

/**
 * 首次进入伙伴互动时的一次性说明弹窗:明确「伙伴由 AI 驱动、不具备人类
 * 情感意识」,用户确认后才进入互动。确认是设备级一次性记录(见
 * botAiDisclosure.ts),之后由各对话头的 BotAiBadge 提供持续可见标识。
 *
 * 弹窗不可通过遮罩点击或 Esc 关闭——必须显式确认,这是本次交互的全部目的;
 * 但也只要求一次确认,不把后续每次进入都变成阻塞。
 */
export function BotAiDisclosureGate() {
  const [acknowledged, setAcknowledged] = useState(isBotAiDisclosureAcknowledged);
  if (acknowledged) return null;
  return <BotAiDisclosureDialog onConfirm={() => setAcknowledged(true)} />;
}

export function BotAiDisclosureDialog({ onConfirm }: { onConfirm: () => void }) {
  const { t } = useTranslation();
  const confirm = () => {
    acknowledgeBotAiDisclosure();
    onConfirm();
  };
  return (
    <Dialog.Root open onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="modal-panel fixed left-1/2 top-1/2 z-[71] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 p-5 outline-none"
        >
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)] text-[var(--text-secondary)]">
              <Bot size={18} aria-hidden />
            </span>
            <div>
              <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
                {t('bots.aiDisclosure.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.aiDisclosure.description')}
              </Dialog.Description>
              <p className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
                {t('bots.aiDisclosure.detail')}
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <Button variant="cta" size="md" compact type="button" onClick={confirm} autoFocus>
              {t('bots.aiDisclosure.confirm')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
