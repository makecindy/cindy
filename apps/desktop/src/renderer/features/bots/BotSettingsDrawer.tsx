import { useEffect, useRef } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { matchPath, useBlocker, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { BotPronounProvider, useBotTranslation } from './botPronounContext';
import { BotSettings } from './BotsHomeView';
import { useBotProfiles } from './botStore';

/** Route-owned compact drawer that keeps the current teammate chat mounted below it. */
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

  const allowNavigation = useRef(false);
  const pendingGuard = useRef<Promise<boolean> | null>(null);
  const beforeCloseRef = useRef<(() => Promise<boolean>) | null>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (allowNavigation.current) {
      allowNavigation.current = false;
      return false;
    }
    return (
      open &&
      beforeCloseRef.current !== null &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search)
    );
  });
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let active = true;
    const check =
      pendingGuard.current ?? Promise.resolve().then(() => beforeCloseRef.current?.() ?? true);
    pendingGuard.current = check;
    void check
      .then(
        (allowed) => {
          if (!active) return;
          if (allowed) blocker.proceed();
          else blocker.reset();
        },
        () => {
          if (active) blocker.reset();
        },
      )
      .finally(() => {
        if (pendingGuard.current === check) pendingGuard.current = null;
      });
    return () => {
      active = false;
    };
  }, [blocker]);

  const performClose = (alreadyChecked = true) => {
    // These callers already passed BotSettings' async save/draft guard.
    allowNavigation.current = alreadyChecked;
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

  // Header, Escape and overlay dismissal take the same route guard as Back
  // and sidebar navigation. BotSettings' own Back action already checked it.
  const close = () => performClose(false);

  if (!bot) return null;

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        {/* Keep portaled controls inside the overlay’s React tree so its scroll lock allows them. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]">
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-[var(--border-default)] bg-[var(--surface)] outline-none"
          >
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
              <Dialog.Title className="text-15 font-medium text-[var(--text-primary)]">
                {t('bots.settings')}
              </Dialog.Title>
              <Dialog.Close
                className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                aria-label={t('bots.close')}
              >
                <X size={17} />
              </Dialog.Close>
            </header>
            <BotPronounProvider bot={bot}>
              <BotSettings
                key={bot.id}
                beforeCloseRef={beforeCloseRef}
                bot={bot}
                onBack={performClose}
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
