import { Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function BotCreateMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => navigate('/bots/roster')}
      className={
        compact
          ? 'flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover'
          : 'flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]'
      }
      aria-label={t('bots.add')}
    >
      <Plus size={compact ? 16 : 15} />
    </button>
  );
}
