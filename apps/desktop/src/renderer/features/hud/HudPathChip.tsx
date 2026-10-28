import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';

/** Tail-first display, but clipboard always receives the original full path. */
export function HudPathChip({ path }: { path: string }) {
  const { t } = useTranslation();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('hud.pathCopied'));
    } catch {
      toast.error(t('hud.failed'));
    }
  };
  return (
    <Tip text={path} mono side="bottom">
      <button
        type="button"
        className="hud-path-chip text-12 text-muted-foreground"
        aria-label={`${t('hud.copyPath')}: ${path}`}
        onClick={() => void copy()}
      >
        <span dir="rtl">
          <bdi dir="ltr">{path}</bdi>
        </span>
      </button>
    </Tip>
  );
}
