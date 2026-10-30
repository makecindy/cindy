import { useRef, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';

/** A persistent entry: opening a native picker must not depend on hover or existing projects. */
export function SidebarAddProjectAction({
  onCreateProject,
}: {
  onCreateProject: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const label = t('ccAgent.sidebar.addProjectFolder');
  return (
    <Tip text={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={pending}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)] disabled:opacity-40"
        onClick={async () => {
          if (busy.current) return;
          busy.current = true;
          setPending(true);
          try {
            await onCreateProject();
          } finally {
            busy.current = false;
            setPending(false);
          }
        }}
      >
        {pending ? (
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        ) : (
          <FolderPlus size={14} aria-hidden="true" />
        )}
      </button>
    </Tip>
  );
}
