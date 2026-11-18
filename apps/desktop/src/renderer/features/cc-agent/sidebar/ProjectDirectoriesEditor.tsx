import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, FolderPlus, X } from 'lucide-react';
import type { ProjectDirectory } from '@cindy/maker-shared/project-alias-sync';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';

/** The same draft editor is used by project creation and project settings. */
export function ProjectDirectoriesEditor({
  mainDirectory,
  automatic = false,
  onMainDirectoryChange,
  onChooseMainDirectory,
  copied,
  onCopy,
  allowAdd = true,
  showHint = true,
  value,
  onChange,
  disabled,
  local,
  onBrowse,
  projectGrantScope,
}: {
  mainDirectory: string;
  automatic?: boolean;
  onMainDirectoryChange?: (path: string) => void;
  onChooseMainDirectory?: () => void;
  copied: boolean;
  onCopy: () => void;
  allowAdd?: boolean;
  showHint?: boolean;
  value: readonly ProjectDirectory[];
  onChange(value: ProjectDirectory[]): void;
  disabled: boolean;
  local: boolean;
  onBrowse?: () => void;
  projectGrantScope: string;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`projectSettings.${key}`);
  const [path, setPath] = useState('');
  const [enteringPath, setEnteringPath] = useState(false);
  const [error, setError] = useState(false);
  const add = (candidate: string) => {
    const clean = candidate.trim();
    if (!clean || clean === mainDirectory || value.some((item) => item.path === clean)) return;
    if (!mainDirectory && onMainDirectoryChange) onMainDirectoryChange(clean);
    else onChange([...value, { path: clean, access: 'write' }]);
    setPath('');
    setEnteringPath(false);
  };
  return (
    <FormField label={label('directories')} hint={showHint ? label('directoriesHint') : undefined}>
      {() => (
        <div className="flex flex-col gap-3">
          {mainDirectory && (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="select-text break-all text-13 text-[var(--text-primary)]">
                  {mainDirectory}
                </p>
                <p className="text-12 text-[var(--text-secondary)]">
                  {label(automatic ? 'automaticMain' : 'mainDirectory')}
                </p>
              </div>
              {onChooseMainDirectory && (
                <Button
                  variant="secondary"
                  tone="quiet"
                  className="shrink-0"
                  disabled={disabled}
                  onClick={onChooseMainDirectory}
                >
                  {label('changeMainDirectory')}
                </Button>
              )}
              {!automatic && (
                <Button
                  variant="secondary"
                  tone="quiet"
                  className="w-8 shrink-0 px-0"
                  aria-label={label(
                    onMainDirectoryChange ? 'removeDirectory' : copied ? 'copied' : 'copy',
                  )}
                  disabled={disabled}
                  onClick={() => {
                    if (onMainDirectoryChange) {
                      onMainDirectoryChange(value[0]?.path ?? '');
                      onChange(value.slice(1));
                    } else onCopy();
                  }}
                >
                  {onMainDirectoryChange ? (
                    <X size={15} />
                  ) : copied ? (
                    <Check size={15} />
                  ) : (
                    <Copy size={15} />
                  )}
                </Button>
              )}
            </div>
          )}
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
          {allowAdd &&
            !automatic &&
            value.length < 10 &&
            (enteringPath ? (
              <div className="flex flex-col gap-2">
                <Input
                  autoFocus
                  value={path}
                  onChange={setPath}
                  placeholder={label('directoryPath')}
                  aria-label={label('directoryPath')}
                  disabled={disabled}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      add(path);
                    }
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEnteringPath(false);
                      setPath('');
                    }}
                  >
                    {label('cancel')}
                  </Button>
                  <Button disabled={disabled || !path.trim()} onClick={() => add(path)}>
                    {label(mainDirectory ? 'addDirectory' : 'chooseExistingFolder')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="secondary"
                disabled={disabled}
                className="self-start"
                onClick={() => {
                  if (onBrowse) {
                    onBrowse();
                    return;
                  }
                  if (!local) {
                    setEnteringPath(true);
                    return;
                  }
                  setError(false);
                  void window.electronAPI.dialog
                    .showOpenDirectory({ projectGrantScope })
                    .then((result) => {
                      if (result.success && result.path) add(result.path);
                    })
                    .catch(() => setError(true));
                }}
              >
                <FolderPlus size={15} />
                {label(mainDirectory ? 'addDirectory' : 'chooseExistingFolder')}
              </Button>
            ))}
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
