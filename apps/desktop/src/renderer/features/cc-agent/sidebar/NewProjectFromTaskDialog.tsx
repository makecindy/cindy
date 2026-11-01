import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Folder } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import { extractIpcError } from '../../../../shared/ipcError';
import { sessionMoveFailureFeedback } from '../../../../shared/worktreeMoveGuardError';
import type {
  CreateProjectFromTaskResult,
  PreparedProjectFromTask,
} from '../../../../shared/projectsRoot';

type NameError = 'nameTaken' | 'nameInvalid' | null;

/**
 * Create a folder under the projects root and move the task there. Main owns the whole
 * transaction (check → folder → dialogue files → register → move → roll back on failure).
 */
export function NewProjectFromTaskDialog({
  sessionId,
  onOpenChange,
  onCreated,
}: {
  sessionId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: CreateProjectFromTaskResult) => void;
}) {
  const { t } = useTranslation();
  const api = window.electronAPI.createProjectFromTask;
  const [prepared, setPrepared] = useState<PreparedProjectFromTask | null>(null);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [remember, setRemember] = useState(false);
  const [nameError, setNameError] = useState<NameError>(null);
  const [creating, setCreating] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    void api
      .prepare(sessionId)
      .then((value) => {
        if (!mounted.current) return;
        setPrepared(value);
        setName(value.suggestedName);
        setParentDir(value.root.path);
        setRemember(value.root.source !== 'setting');
      })
      .catch(() => {
        if (!mounted.current) return;
        toast.error(t('ccAgent.sidebar.newProjectDialog.loadFailed'));
        onOpenChange(false);
      });
    return () => {
      mounted.current = false;
    };
  }, [api, onOpenChange, sessionId, t]);

  useEffect(() => {
    if (prepared) nameInputRef.current?.focus();
  }, [prepared]);

  const root = prepared?.root;
  const atRoot = !!root && parentDir === root.path;
  const separator = window.electronAPI.platform === 'win32' ? '\\' : '/';
  const targetPath = name.trim() ? `${parentDir.replace(/[\\/]+$/, '')}${separator}${name.trim()}` : '';
  const showRemember = !!root && !(atRoot && root.source === 'setting');

  const chooseLocation = async () => {
    try {
      const selected = await api.chooseParent();
      if (selected && mounted.current) setParentDir(selected);
    } catch {
      toast.error(t('ccAgent.sidebar.newProjectDialog.failed'));
    }
  };

  const submit = async () => {
    if (!prepared || !name.trim() || submitting.current) return;
    submitting.current = true;
    setCreating(true);
    setNameError(null);
    try {
      const result = await api.create({ sessionId, name: name.trim(), parentDir, remember: showRemember && remember });
      if (!mounted.current) return;
      onCreated(result);
      onOpenChange(false);
    } catch (error) {
      if (!mounted.current) return;
      const code = extractIpcError(error)?.code;
      if (code === 'ALREADY_EXISTS') setNameError('nameTaken');
      else if (code === 'INVALID_PARAMS') setNameError('nameInvalid');
      else {
        const feedback = sessionMoveFailureFeedback('newProject', error);
        const key =
          feedback.level === 'warning' ? feedback.key : 'ccAgent.sidebar.newProjectDialog.failed';
        if (feedback.level === 'warning') toast.warning(t(key));
        else toast.error(t(key));
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const locationHint =
    root && atRoot
      ? root.source === 'inferred'
        ? t('ccAgent.sidebar.newProjectDialog.locationInferred')
        : root.source === 'default' && !root.exists
          ? t('ccAgent.sidebar.newProjectDialog.locationWillCreate')
          : undefined
      : undefined;

  return (
    <Dialog.Root open onOpenChange={(open) => !submitting.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (submitting.current || event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          className="modal-panel fixed left-1/2 top-1/2 z-[10001] flex max-h-[85vh] w-[min(460px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto p-4 outline-none"
        >
          <Dialog.Title className="text-16 font-semibold text-[var(--confirm-title)]">
            {t('ccAgent.sidebar.newProjectDialog.title')}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-13 leading-relaxed text-[var(--confirm-desc)]">
            {t(
              prepared?.movesFiles
                ? 'ccAgent.sidebar.newProjectDialog.descriptionMoveFiles'
                : 'ccAgent.sidebar.newProjectDialog.description',
            )}
          </Dialog.Description>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <FormField
              label={t('ccAgent.sidebar.newProjectDialog.nameLabel')}
              required
              reserveFeedback
              error={nameError ? t(`ccAgent.sidebar.newProjectDialog.${nameError}`) : undefined}
              hint={targetPath ? t('ccAgent.sidebar.newProjectDialog.targetPath', { path: targetPath }) : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  inputRef={nameInputRef}
                  size="sm"
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    setNameError(null);
                  }}
                  placeholder={t('ccAgent.sidebar.newProjectDialog.namePlaceholder')}
                  maxLength={120}
                  disabled={!prepared || creating}
                  error={nameError !== null}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </FormField>
            <FormField label={t('ccAgent.sidebar.newProjectDialog.location')} hint={locationHint}>
              {(control) => (
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    id={control.id}
                    aria-describedby={control['aria-describedby']}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-13 text-[var(--text-secondary)]"
                    title={parentDir}
                  >
                    <Folder size={15} className="shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{parentDir}</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    disabled={!prepared || creating}
                    onClick={() => void chooseLocation()}
                  >
                    {t('ccAgent.sidebar.newProjectDialog.changeLocation')}
                  </Button>
                </div>
              )}
            </FormField>
            {showRemember && (
              <label className="flex min-h-9 items-center gap-2 text-13 text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-[var(--text-primary)]"
                  checked={remember}
                  disabled={creating}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>{t('ccAgent.sidebar.newProjectDialog.remember')}</span>
              </label>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary" size="lg" disabled={creating} palette="confirmation">
                  {t('ccAgent.sidebar.newProjectDialog.cancel')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                size="lg"
                disabled={!prepared || !name.trim()}
                loading={creating}
                palette="confirmation"
              >
                {t('ccAgent.sidebar.newProjectDialog.create')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
