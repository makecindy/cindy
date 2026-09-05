import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { matchPath, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { BotPronounProvider, useBotTranslation } from './botPronounContext';
import { BotSettings } from './BotsHomeView';
import { useBotProfiles } from './botStore';

/** Route-owned half-window that keeps the current teammate chat mounted below it. */
export function BotSettingsDrawer() {
  const { t } = useBotTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const bots = useBotProfiles();
  const match =
    matchPath('/bots/:botId/*', location.pathname) ?? matchPath('/bots/:botId', location.pathname);
  const bot = bots.find((candidate) => candidate.id === match?.params.botId) ?? null;
  const open = searchParams.get('settings') === '1' && bot !== null;

  const close = () => {
    if (bot?.status === 'archived') {
      navigate('/bots', { replace: true });
      return;
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('settings');
        return next;
      },
      { replace: true },
    );
  };

  if (!bot) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]">
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-[var(--border-default)] bg-[var(--surface)] outline-none sm:w-[min(640px,70vw)] lg:w-1/2 lg:max-w-[720px]"
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5 sm:px-7">
              <Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">
                {t('bots.settings')}
              </Dialog.Title>
              <Dialog.Close
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('bots.close')}
              >
                <X size={17} />
              </Dialog.Close>
            </header>
            <BotPronounProvider bot={bot}>
              <BotSettings
                key={bot.id}
                bot={bot}
                onBack={close}
                onOpenSession={(sessionId, searchJump) => {
                  const projection = bot.sessions.find((item) => item.id === sessionId);
                  const route =
                    projection?.kind === 'history'
                      ? `/bots/${bot.id}/history/${sessionId}`
                      : `/bots/${bot.id}/session/${sessionId}`;
                  navigate(route, { state: searchJump ? { searchJump } : undefined });
                }}
              />
            </BotPronounProvider>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
