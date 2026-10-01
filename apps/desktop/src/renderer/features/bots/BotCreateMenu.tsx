import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { BotRosterView } from './BotRosterView';
import { useTranslation } from 'react-i18next';

export function BotCreateMenu({ compact = false, label }: { compact?: boolean; label?: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <>
      {label ? (
        <Button
          ref={trigger}
          variant="secondary"
          size="lg"
          onClick={() => setOpen(true)}
          aria-label={t('bots.add')}
        >
          <Plus size={15} />
          {label}
        </Button>
      ) : (
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        className={ compact
              ? 'flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover'
              : 'flex h-7 w-7 items-center justify-center rounded-full text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]'
        }
        aria-label={t('bots.add')}
      >
        <Plus size={compact ? 16 : 15} />
      </button>
      )}
      {open ? (
        <BotRosterView
          restoreFocus={() => trigger.current?.focus()}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
