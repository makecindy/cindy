import { FileInput } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * 插件详情「配置」区的「用这个插件打开文件」开关。只在插件声明了 `fileOpener` 时渲染;
 * 默认开,关掉后 Host 不再把这些类型的文件交给它,改用系统默认应用。
 */
export function PluginFileOpenerSwitch({
  ghostId,
  name,
  extensions,
  surfaceClassName,
}: {
  ghostId: string;
  name: string;
  extensions: readonly string[];
  surfaceClassName: string;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    const api = window.electronAPI.ghosts;
    if (typeof api.fileOpener !== 'function') return undefined;
    api.fileOpener(ghostId).then(
      (result) => {
        if (alive) setEnabled(result.declared ? result.enabled : null);
      },
      () => {
        if (alive) setEnabled(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [ghostId]);

  if (enabled === null) return null;

  return (
    <div className={cn(surfaceClassName, 'flex min-h-20 items-center gap-3 rounded-xl px-5 py-4')}>
      <FileInput size={18} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium leading-[1.571] text-[var(--text-primary)]">
          {t('settings.ghosts.detail.fileOpenerTitle')}
        </p>
        <p className="mt-0.5 text-13 leading-[1.54] text-[var(--text-secondary)]">
          {t('settings.ghosts.detail.fileOpenerDescription', { name, extensions: extensions.join(' ') })}
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={saving}
        aria-label={t('settings.ghosts.detail.fileOpenerTitle')}
        onCheckedChange={async (next) => {
          setSaving(true);
          setEnabled(next);
          try {
            const result = await window.electronAPI.ghosts.setFileOpener(ghostId, next);
            setEnabled(result.enabled);
          } catch {
            setEnabled(!next);
          } finally {
            setSaving(false);
          }
        }}
      />
    </div>
  );
}
