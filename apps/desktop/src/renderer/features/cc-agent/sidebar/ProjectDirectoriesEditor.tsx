import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderPlus, X } from 'lucide-react';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';

/** The same draft editor is used by project creation and project settings. */
export function ProjectDirectoriesEditor({
  value,
  onChange,
  disabled,
  local,
  onBrowse,
}: {
  value: readonly ProjectDirectory[];
  onChange(value: ProjectDirectory[]): void;
  disabled: boolean;
  local: boolean;
  onBrowse?: () => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`projectSettings.${key}`);
  const [path, setPath] = useState('');
  const [error, setError] = useState(false);
  const add = (candidate: string) => {
    const clean = candidate.trim();
    if (!clean || value.some((item) => item.path === clean)) return;
    onChange([...value, { path: clean, access: 'write' }]);
    setPath('');
  };
  return (
    <FormField label={label('directories')} hint={label('directoriesHint')}>
      {() => (
        <div className="flex flex-col gap-3">
          {value.map((item, index) => (
            <div
              key={item.path}
              className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] p-3"
            >
              <span className="min-w-0 flex-1 select-text break-all text-13 text-[var(--text-primary)]">
                {item.path}
              </span>
              <Button
                variant="secondary"
                tone="quiet"
                className="ml-auto w-8 px-0"
                disabled={disabled}
                aria-label={label('removeDirectory')}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
              >
                <X size={15} />
              </Button>
            </div>
          ))}
          {value.length < 10 && (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={path}
                onChange={setPath}
                placeholder={label('directoryPath')}
                aria-label={label('directoryPath')}
                disabled={disabled}
                className="min-w-0 flex-1 basis-full sm:basis-0"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    add(path);
                  }
                }}
              />
              <Button disabled={disabled || !path.trim()} onClick={() => add(path)}>
                {label('addDirectory')}
              </Button>
              {(local || onBrowse) && (
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => {
                    if (onBrowse) {
                      onBrowse();
                      return;
                    }
                    setError(false);
                    void window.electronAPI
                      .showOpenDirectoryDialog()
                      .then((result) => {
                        if (!result.canceled && result.path) add(result.path);
                      })
                      .catch(() => setError(true));
                  }}
                >
                  <FolderPlus size={15} />
                  {label('browseDirectory')}
                </Button>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-13 text-[var(--text-danger)]">
              {label('failed')}
            </p>
          )}
        </div>
      )}
    </FormField>
  );
}
