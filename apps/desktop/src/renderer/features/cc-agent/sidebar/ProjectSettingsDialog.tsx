import { FileInput, FolderMinus, Pin, PinOff } from 'lucide-react';
import { extractIpcError } from '@/utils/ipcError';
import {
  isExplicitProjectRepositoryAddress,
  parseProjectRepository,
  projectCreationFolderName,
} from '@cindy/maker-shared/project-alias-sync';
import { deviceLinkProjectKey } from '../../../../shared/projectKeys';
import { AddRemoteProjectDialog } from '@/components/new-chat/AddRemoteProjectDialog';
import { ProjectDirectoriesEditor } from './ProjectDirectoriesEditor';
import {
  resolveProjectDirectories,
  type ProjectDirectory,
} from '@cindy/maker-shared/project-alias-sync';
import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Check,
  Pencil,
  ChevronDown,
  ImagePlus,
  Monitor,
  RotateCcw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  isProjectImage,
  isProjectImageDraft,
  PROJECT_EMOJIS,
  PROJECT_SYMBOLS,
  PROJECT_ICON_COLORS,
  parseProjectSymbol,
  parseProjectLetters,
  projectLettersValue,
  projectSymbolValue,
  type ProjectIconColor,
  PROJECT_SETTINGS_SET_CHANNEL,
  projectDirectoryName,
  defaultProjectLetters,
  defaultProjectColor,
  resolveProjectIcon,
  projectAliasComparisonKey,
  validProjectIcon,
} from '@cindy/maker-shared/project-alias-sync';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useProjectInfo } from '../hooks/useProjectInfo';
import type { ProjectNode } from '../lib/projectGrouping';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { ProjectIcon, useAutomaticProjectIcon } from './ProjectIcon';
import { ProjectIntro, useProjectIntro } from './ProjectIntro';
export function projectHostKey(project: ProjectNode): string {
  if (!project.deviceLinkDeviceId) return project.projectKey;
  const hosts = new Set(project.sessions.map((session) => session.remoteHostId ?? null));
  if (hosts.size > 1) return '';
  const host = hosts.size ? hosts.values().next().value : project.remoteHostId;
  return host
    ? `remote:${encodeURIComponent(host)}:${project.workingDir}`
    : `local:${project.workingDir}`;
}

export function ProjectSettingsDialog({
  project,
  isPinned = false,
  onTogglePin,
  onImport,
  onRemove,
  onClose,
  create = false,
  onCreated,
}: {
  project: ProjectNode;
  isPinned?: boolean;
  onTogglePin?: (project: ProjectNode, currentlyPinned: boolean) => void;
  onImport?: (project: ProjectNode) => void;
  onRemove?: (project: ProjectNode) => void;
  create?: boolean;
  onCreated?(path: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`projectSettings.${key}`);
  const [intro, closeIntro] = useProjectIntro(create);
  const colorLabel = (color: ProjectIconColor) =>
    color === 'default' ? label('colors.default') : t(`taskTags.${color}`);
  const chooseColor = (color: ProjectIconColor) => {
    setPickerColor(color);
    setColorOpen(false);
    if (mode === 'letters') {
      if (validProjectIcon(`text:${letters}`)) setPickerIcon(letterValue(letters, color));
    } else {
      setPickerIcon(projectSymbolValue(parseProjectSymbol(pickerIcon)?.name ?? 'Folder', color));
    }
  };
  const snapshot = useProjectInfo(project.deviceLinkDeviceId);
  const [projectGrantScope] = useState(() => crypto.randomUUID());
  const [remoteBrowse, setRemoteBrowse] = useState<'main' | 'additional' | null>(null);
  const [directory, setDirectory] = useState(project.workingDir);
  const key = create ? `local:${directory}` : projectHostKey(project);
  const automatic = useAutomaticProjectIcon(
    key,
    project.deviceLinkDeviceId,
    !!directory && (snapshot?.settingsVersion ?? 0) >= 4,
  );
  const defaultName = projectDirectoryName(directory);
  const [name, setName] = useState(project.displayName);
  const nameEdited = useRef(!!project.displayName.trim());
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [source, setSource] = useState<'local' | 'repository'>('local');
  const repositoryExpanded = source === 'repository';
  const chooseSource = (next: 'local' | 'repository') => {
    if (next === source) return;
    setSource(next);
    setRepositoryUrl('');
    setDirectory('');
    setDirectories([]);
    setError(null);
  };
  const repositoryCreation = create && (snapshot?.settingsVersion ?? 0) >= 7;
  const automaticDirectory = repositoryCreation && !directory;
  const directoryPreview = automaticDirectory
    ? `${snapshot?.creationRoot ?? ''}/${projectCreationFolderName(name || parseProjectRepository(repositoryUrl)?.name || 'Project')}`
    : directory;
  const changeRepository = (value: string) => {
    const previous = parseProjectRepository(repositoryUrl);
    const next = parseProjectRepository(value);
    setRepositoryUrl(value);
    setError(null);
    if (next && (!name.trim() || name === previous?.name)) setName(next.name.slice(0, 80));
  };
  const changeName = (value: string) => {
    nameEdited.current = !!value.trim();
    // Names such as Design/2027 must not silently become GitHub repositories.
    const address = isExplicitProjectRepositoryAddress(value);
    const repository = repositoryCreation && address ? parseProjectRepository(value) : null;
    if (repository) {
      if (source !== 'repository') chooseSource('repository');
      setError(null);
      setRepositoryUrl(value.trim());
      setName(repository.name.slice(0, 80));
    } else setName(value.slice(0, 80));
  };

  const [directories, setDirectories] = useState<readonly ProjectDirectory[]>([]);
  const [initialDirectories, setInitialDirectories] = useState<readonly ProjectDirectory[]>([]);
  const [icon, setIcon] = useState<string | null>(null);
  const [initial, setInitial] = useState<{ name: string; icon: string | null } | null>(null);
  useEffect(() => {
    if (snapshot && !initial) {
      const next = resolveProjectIcon(snapshot, key);
      setInitial({ name: project.displayName, icon: next });
      setIcon(next);
      const roots = resolveProjectDirectories(snapshot, key) ?? [];
      setDirectories(roots);
      setInitialDirectories(roots);
    }
  }, [snapshot, initial, key, project.displayName]);
  const initializedCreationKey = useRef(key);
  useEffect(() => {
    if (!create || !snapshot || !initial || initializedCreationKey.current === key) return;
    initializedCreationKey.current = key;
    const comparison = projectAliasComparisonKey(key, snapshot.platform);
    const savedName =
      snapshot.aliases.find(
        (row) => projectAliasComparisonKey(row.projectKey, snapshot.platform) === comparison,
      )?.alias ?? '';
    const savedIcon = resolveProjectIcon(snapshot, key);
    const savedDirectories = resolveProjectDirectories(snapshot, key) ?? [];
    if (directory) {
      setName((current) =>
        !current.trim() || !nameEdited.current
          ? savedName || projectDirectoryName(directory).slice(0, 80)
          : current,
      );
    }
    setIcon((current) => (current === initial.icon ? savedIcon : current));
    setDirectories((current) =>
      JSON.stringify(current) === JSON.stringify(initialDirectories) ? savedDirectories : current,
    );
    setInitial({ name: savedName, icon: savedIcon });
    setInitialDirectories(savedDirectories);
  }, [create, key, directory, snapshot, initial, initialDirectories]);
  const [stage, setStage] = useState<'profile' | 'icon'>('profile');
  const [mode, setMode] = useState<'symbols' | 'emoji' | 'letters' | 'image'>('symbols');
  const [pickerIcon, setPickerIcon] = useState<string | null>(null);
  const [pickerColor, setPickerColor] = useState<ProjectIconColor>('default');
  const letterValue = (text: string, color = pickerColor) =>
    projectLettersValue(text, (snapshot?.settingsVersion ?? 0) >= 5 ? color : 'default');
  const [colorOpen, setColorOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [customEmoji, setCustomEmoji] = useState('');
  const [letters, setLetters] = useState('');
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const [copied, setCopied] = useState(false);
  const lock = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const [owner] = useState(getDataOwnerGeneration);
  const available = !!initial && (snapshot?.settingsVersion ?? 0) >= (create ? 6 : 2);
  const dirty =
    !!initial &&
    ((create && (!!directory.trim() || !!repositoryUrl.trim())) ||
      name.trim() !== initial.name ||
      icon !== initial.icon ||
      JSON.stringify(directories) !== JSON.stringify(initialDirectories));
  const leave = (action?: () => void) => {
    if (busy || imageBusy) return;
    const finish = () => {
      onClose();
      if (isDataOwnerGenerationCurrent(owner)) action?.();
    };
    if (dirty) setDiscard(() => finish);
    else finish();
  };
  const close = () => {
    if (busy || imageBusy) return;
    if (stage === 'icon') {
      setStage('profile');
      setError(null);
      return;
    }
    leave();
  };
  const save = async () => {
    if (
      lock.current ||
      !available ||
      !dirty ||
      (create && (snapshot?.settingsVersion ?? 0) < 7 && !directory.trim()) ||
      !snapshot?.ownerStamp ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    if (repositoryCreation && repositoryExpanded && !parseProjectRepository(repositoryUrl)) {
      setError(label('invalidRepository'));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    const value: {
      name?: string;
      icon?: string | null;
      directories?: readonly ProjectDirectory[];
    } = {};
    if (name.trim() !== initial!.name) value.name = name.trim() === defaultName ? '' : name.trim();
    if (create && !directory && name.trim()) value.name = name.trim();
    if (icon !== initial!.icon) value.icon = icon;
    if (
      (create && resolveProjectDirectories(snapshot, key) === undefined) ||
      JSON.stringify(directories) !== JSON.stringify(initialDirectories)
    )
      value.directories = directories;
    try {
      const request = {
        create,
        ...(create && repositoryUrl.trim() ? { repositoryUrl: repositoryUrl.trim() } : {}),
        projectKey: key,
        field: 'profile' as const,
        value,
        projectGrantScope,
        ...snapshot.ownerStamp,
      };
      let result: { createdProjectKey?: string };
      if (project.deviceLinkDeviceId) {
        result = (await window.electronAPI.deviceLink.invoke(
          project.deviceLinkDeviceId,
          PROJECT_SETTINGS_SET_CHANNEL,
          [request],
        )) as { createdProjectKey?: string };
        if ('name' in value && directory && isDataOwnerGenerationCurrent(owner))
          await window.electronAPI.localDb.projectAliases.delete(
            deviceLinkProjectKey(project.deviceLinkDeviceId, directory),
          );
      } else result = await window.electronAPI.localDb.projectAliases.updateInfo(request);
      const createdDirectory = result?.createdProjectKey?.startsWith('local:')
        ? result.createdProjectKey.slice(6)
        : directory;
      if (isDataOwnerGenerationCurrent(owner)) {
        if (create) onCreated?.(createdDirectory);
        onClose();
      }
    } catch (error) {
      if (extractIpcError(error)?.code !== 'MUTATION_CANCELLED')
        setError(label(create ? 'createFailed' : 'failed'));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const upload = async (selected?: File) => {
    if (!selected) return;
    setImageBusy(true);
    setError(null);
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
        selected.size > 10 * 1024 * 1024
      )
        throw new Error();
      const bitmap = await createImageBitmap(selected);
      try {
        if (bitmap.width * bitmap.height > 16_000_000) throw new Error();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        if (!context) throw new Error();
        const edge = Math.min(bitmap.width, bitmap.height);
        context.drawImage(
          bitmap,
          (bitmap.width - edge) / 2,
          (bitmap.height - edge) / 2,
          edge,
          edge,
          0,
          0,
          256,
          256,
        );
        let uri = canvas.toDataURL('image/png');
        if (uri.length > 300_000) uri = canvas.toDataURL('image/jpeg', 0.85);
        if (uri.length > 300_000) throw new Error();
        setPickerIcon(uri);
        setCustomEmoji('');
        setMode('image');
      } finally {
        bitmap.close();
      }
    } catch {
      setError(label('imageError'));
    } finally {
      setImageBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const openPicker = () => {
    setPickerIcon(icon);
    setPickerColor(
      (snapshot?.settingsVersion ?? 0) >= 3
        ? (parseProjectSymbol(icon)?.color ??
            parseProjectLetters(icon)?.color ??
            defaultProjectColor(name.trim() || defaultName))
        : 'default',
    );
    setMode(
      isProjectImage(icon) || isProjectImageDraft(icon)
        ? 'image'
        : icon?.startsWith('text:')
          ? 'letters'
          : icon && !icon.includes(':')
            ? 'emoji'
            : 'symbols',
    );
    setLetters(parseProjectLetters(icon)?.text ?? '');
    setCustomEmoji('');
    setColorOpen(false);
    setQuery('');
    setError(null);
    setStage('icon');
  };
  const draw = (value: string | null, size: number) => (
    <ProjectIcon
      value={value}
      projectKey={key}
      projectName={name.trim() || defaultName}
      automaticEnabled={!!directory && (snapshot?.settingsVersion ?? 0) >= 4}
      deviceId={project.deviceLinkDeviceId}
      size={size}
    />
  );
  const pickerInvalid =
    (mode === 'letters' && !!letters && !validProjectIcon(`text:${letters}`)) ||
    (mode === 'emoji' &&
      !!customEmoji &&
      (!validProjectIcon(customEmoji) || customEmoji.includes(':')));
  const symbols = PROJECT_SYMBOLS.filter((item) =>
    `${item.name} ${item.keywords}`.toLowerCase().includes(query.toLowerCase().trim()),
  );
  // The first new project on this computer starts with the introduction; the form follows it.
  if (intro) return <ProjectIntro open onClose={closeIntro} />;
  return (
    <>
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-scrim fixed inset-0 z-50" />
          <Dialog.Content
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
            }}
            className="modal-panel fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100%_-_32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 pt-5 pb-4">
              {stage === 'icon' && (
                <Button
                  variant="secondary"
                  tone="quiet"
                  className="w-8 px-0"
                  aria-label={label('back')}
                  onClick={close}
                >
                  <ArrowLeft size={16} />
                </Button>
              )}
              <Dialog.Title className="min-w-0 flex-1 text-20 font-medium text-[var(--text-primary)]">
                {label(stage === 'icon' ? 'chooseIcon' : create ? 'createTitle' : 'title')}
              </Dialog.Title>
              <Button
                variant="secondary"
                tone="quiet"
                className="w-8 px-0"
                aria-label={label('cancel')}
                disabled={busy || imageBusy}
                onClick={close}
              >
                <X size={16} />
              </Button>
            </div>
            <Dialog.Description className="sr-only">
              {label(repositoryCreation ? `sourceHint_${source}` : 'nameHint')}
            </Dialog.Description>
            <div className="min-h-0 overflow-y-auto px-4 pb-6">
              {discard ? (
                <div className="flex flex-col gap-4 py-4">
                  <p className="text-15 text-[var(--text-primary)]">{label('discardHint')}</p>
                  <div className="flex justify-end gap-2">
                    <Button onClick={() => setDiscard(null)}>{label('keepEditing')}</Button>
                    <Button variant="cta" onClick={discard}>
                      {label('discard')}
                    </Button>
                  </div>
                </div>
              ) : stage === 'profile' ? (
                <div className="flex flex-col gap-5">
                  {repositoryCreation && (
                    <div className="flex flex-col gap-2">
                      <SegmentedControl
                        value={source}
                        onValueChange={chooseSource}
                        aria-label={label('source')}
                        disabled={busy || !available}
                        fullWidth
                        optionClassName="min-w-0 flex-1 px-2"
                        options={(['local', 'repository'] as const).map((item) => ({
                          value: item,
                          label: label(`sourceShort_${item}`),
                          'aria-label': label(`source_${item}`),
                        }))}
                      />
                      <p className="text-12 text-[var(--text-secondary)]">
                        {label(`sourceHint_${source}`)}
                      </p>
                    </div>
                  )}
                  <div className="flex items-end gap-3">
                    <button
                      type="button"
                      disabled={!available || busy}
                      onClick={openPicker}
                      aria-label={label('changeIcon')}
                      className="group relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-hover-soft)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                    >
                      {draw(icon, isProjectImage(icon) || isProjectImageDraft(icon) ? 48 : 28)}
                      <span
                        className="absolute bottom-0 right-0 flex size-6 items-center justify-center rounded-tl-lg bg-[var(--surface-elevated)] text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden="true"
                      >
                        <Pencil size={13} />
                      </span>
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="mb-2 text-13 text-[var(--text-primary)]">
                        {label('createNamePlaceholder')}
                      </p>
                      <Input
                        aria-label={label('name')}
                        value={name}
                        placeholder={
                          repositoryCreation
                            ? label('createNamePlaceholder')
                            : defaultName || label('name')
                        }
                        maxLength={repositoryCreation ? 4096 : 80}
                        disabled={busy || !available}
                        onChange={changeName}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                        inputClassName="text-15"
                      />
                    </div>
                  </div>
                  {!create && (
                    <p className="text-12 text-[var(--text-secondary)]">{label('nameHint')}</p>
                  )}
                  {!!directory &&
                    (snapshot?.settingsVersion ?? 0) >= 4 &&
                    (icon === null || automatic.result?.candidate) && (
                      <div className="flex flex-col gap-2">
                        {icon === null && (
                          <p className="break-all text-12 text-[var(--text-secondary)]">
                            {automatic.loading
                              ? label('autoLoading')
                              : automatic.result?.image && !automatic.result.candidate
                                ? `${label('autoSource')}: ${automatic.result.source}`
                                : label('autoNone')}
                          </p>
                        )}
                        {automatic.result?.candidate && automatic.result.image && (
                          <Button
                            variant="secondary"
                            tone="quiet"
                            className="self-start"
                            disabled={busy || !available}
                            onClick={() => setIcon(automatic.result!.image)}
                          >
                            {draw(automatic.result.image, 24)}
                            {label('githubAvatar')}
                          </Button>
                        )}
                      </div>
                    )}
                  {repositoryCreation && repositoryExpanded && (
                    <div className="flex flex-col gap-2">
                      <FormField label={label('repository')} hint={label('repositoryHint')}>
                        {(control) => (
                          <Input
                            {...control}
                            autoFocus
                            value={repositoryUrl}
                            onChange={changeRepository}
                            disabled={busy}
                            placeholder="https://github.com/owner/repository"
                          />
                        )}
                      </FormField>
                      {busy && repositoryUrl && (
                        <p role="status" className="text-13 text-[var(--text-secondary)]">
                          {label('cloning')}
                        </p>
                      )}
                    </div>
                  )}
                  <div className="flex flex-col gap-3 border-t border-[var(--border-default)] pt-5">
                    <div className="flex items-center gap-2 text-13 text-[var(--text-secondary)]">
                      <Monitor size={15} />
                      <span>{project.deviceLinkDeviceName || label('thisComputer')}</span>
                    </div>
                    <ProjectDirectoriesEditor
                      mainDirectory={directoryPreview}
                      automatic={automaticDirectory}
                      onChooseMainDirectory={
                        repositoryCreation && source === 'local'
                          ? async () => {
                              if (project.deviceLinkDeviceId) {
                                setRemoteBrowse('main');
                                return;
                              }
                              try {
                                const result = await window.electronAPI.dialog.showOpenDirectory({
                                  projectGrantScope,
                                });
                                if (
                                  result.success &&
                                  result.path &&
                                  isDataOwnerGenerationCurrent(owner)
                                )
                                  setDirectory(result.path);
                              } catch {
                                setError(label('failed'));
                              }
                            }
                          : undefined
                      }
                      showHint={!create}
                      copied={copied}
                      onMainDirectoryChange={
                        create && !automaticDirectory
                          ? (path) => {
                              setDirectory(path);
                            }
                          : undefined
                      }
                      onCopy={() =>
                        void navigator.clipboard
                          .writeText(directory)
                          .then(() => setCopied(true))
                          .catch(() => setError(label('failed')))
                      }
                      allowAdd={(snapshot?.settingsVersion ?? 0) >= 6}
                      value={directories}
                      projectGrantScope={projectGrantScope}
                      onChange={setDirectories}
                      disabled={busy || !available}
                      local={!project.deviceLinkDeviceId && !key.startsWith('remote:')}
                      onBrowse={
                        project.deviceLinkDeviceId && !key.startsWith('remote:')
                          ? () => setRemoteBrowse(directoryPreview ? 'additional' : 'main')
                          : undefined
                      }
                    />
                  </div>
                {onTogglePin && (
                  <div className="flex flex-col items-start gap-1 border-t border-[var(--border-default)] pt-3">
                    <Button variant="secondary" tone="quiet" disabled={busy} onClick={() => leave(() => onTogglePin(project, isPinned))}>
                      {isPinned ? <PinOff size={15} /> : <Pin size={15} />}
                      {t(isPinned ? 'ccAgent.sidebar.projectAction.unpin' : 'ccAgent.sidebar.projectAction.pin')}
                    </Button>
                    {project.scope === 'local' && onImport && (
                      <Button variant="secondary" tone="quiet" disabled={busy} onClick={() => leave(() => onImport(project))}>
                        <FileInput size={15} />
                        {t('settings.sessionImport.projectMenu')}
                      </Button>
                    )}
                    {project.scope === 'local' && onRemove && (
                      <Button variant="secondary" tone="quiet" disabled={busy} onClick={() => leave(() => onRemove(project))}>
                        <FolderMinus size={15} />
                        {t('ccAgent.sidebar.projectAction.removeFromSidebar')}
                      </Button>
                    )}
                  </div>
                )}
                </div>
              ) : (
                <div className="flex min-h-[436px] flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-hover-soft)]">
                      {draw(
                        pickerIcon,
                        isProjectImage(pickerIcon) || isProjectImageDraft(pickerIcon) ? 48 : 28,
                      )}
                    </div>
                    <p className="min-w-0 flex-1 truncate text-15 font-medium text-[var(--text-primary)]">
                      {name.trim() || defaultName}
                    </p>
                    <Button
                      variant="secondary"
                      tone="quiet"
                      className="shrink-0"
                      disabled={pickerIcon === null || busy || imageBusy}
                      onClick={() => {
                        setLetters('');
                        setCustomEmoji('');
                        setPickerIcon(null);
                        setPickerColor('default');
                      }}
                    >
                      <RotateCcw size={14} />
                      {label('reset')}
                    </Button>
                  </div>
                  <input
                    ref={file}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    aria-label={label('upload')}
                    onChange={(event) => void upload(event.target.files?.[0])}
                  />
                  <SegmentedControl
                    fullWidth
                    value={mode}
                    onValueChange={(value) => {
                      setMode(value);
                      if (value === 'letters') {
                        const next = letters || defaultProjectLetters(name.trim() || defaultName);
                        setLetters(next);
                        if (validProjectIcon(`text:${next}`)) setPickerIcon(letterValue(next));
                      }
                      setColorOpen(false);
                      setError(null);
                    }}
                    aria-label={label('chooseIcon')}
                    options={(['symbols', 'emoji', 'letters', 'image'] as const).map((value) => ({
                      value,
                      label: label(value),
                    }))}
                  />
                  {((mode === 'symbols' && (snapshot?.settingsVersion ?? 0) >= 3) ||
                    (mode === 'letters' && (snapshot?.settingsVersion ?? 0) >= 5)) && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-13 text-[var(--text-secondary)]">
                        {t('taskTags.color')}
                      </span>
                      <Popover open={colorOpen} onOpenChange={setColorOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="secondary"
                            tone="quiet"
                            aria-label={t('taskTags.color')}
                            aria-description={colorLabel(pickerColor)}
                            disabled={busy || imageBusy}
                            className="min-w-0 gap-2"
                          >
                            <span
                              className="size-4 shrink-0 rounded-full border border-[var(--border-default)]"
                              style={{
                                backgroundColor:
                                  pickerColor === 'default'
                                    ? 'var(--text-primary)'
                                    : `var(--task-tag-${pickerColor})`,
                              }}
                            />
                            <span className="truncate">{colorLabel(pickerColor)}</span>
                            <ChevronDown size={14} className="shrink-0" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="max-w-[calc(100vw-48px)] p-2">
                          <div className="flex flex-col gap-2">
                            <Button
                              variant="secondary"
                              tone="quiet"
                              className="h-auto min-h-10 w-full justify-start gap-2 px-2 py-1"
                              aria-pressed={pickerColor === 'default'}
                              disabled={busy || imageBusy}
                              onClick={() => chooseColor('default')}
                            >
                              <span
                                className={`flex size-8 shrink-0 items-center justify-center rounded-full border ${pickerColor === 'default' ? 'border-[var(--text-primary)]' : 'border-transparent'}`}
                              >
                                <span className="size-5 rounded-full bg-[var(--text-primary)]" />
                              </span>
                              <span className="min-w-0 flex-1 whitespace-normal text-left">
                                {colorLabel('default')}
                              </span>
                              {pickerColor === 'default' && <Check size={14} />}
                            </Button>
                            <div
                              className="grid grid-cols-6 gap-1"
                              role="group"
                              aria-label={t('taskTags.color')}
                            >
                              {PROJECT_ICON_COLORS.filter((color) => color !== 'default').map(
                                (color) => (
                                  <Button
                                    key={color}
                                    variant="secondary"
                                    tone="quiet"
                                    className="h-10 w-10 justify-self-center px-0"
                                    aria-label={colorLabel(color)}
                                    aria-pressed={pickerColor === color}
                                    onClick={() => chooseColor(color)}
                                  >
                                    <span
                                      className={`flex size-8 shrink-0 items-center justify-center rounded-full border ${pickerColor === color ? 'border-[var(--text-primary)]' : 'border-transparent'}`}
                                    >
                                      <span
                                        className="size-5 rounded-full border border-[var(--border-default)]"
                                        style={{ backgroundColor: `var(--task-tag-${color})` }}
                                      />
                                    </span>
                                  </Button>
                                ),
                              )}
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  )}
                  {mode === 'symbols' ? (
                    <>
                      <Input
                        value={query}
                        onChange={setQuery}
                        placeholder={label('search')}
                        aria-label={label('search')}
                      />
                      <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto p-1 sm:grid-cols-8">
                        {symbols.map((item) => (
                          <Button
                            key={item.name}
                            variant="secondary"
                            tone={
                              parseProjectSymbol(pickerIcon)?.name === item.name
                                ? 'default'
                                : 'quiet'
                            }
                            className="h-10 w-full px-0"
                            aria-label={item.name}
                            aria-pressed={parseProjectSymbol(pickerIcon)?.name === item.name}
                            onClick={() =>
                              setPickerIcon(projectSymbolValue(item.name, pickerColor))
                            }
                          >
                            {draw(projectSymbolValue(item.name, pickerColor), 24)}
                          </Button>
                        ))}
                      </div>
                      {symbols.length === 0 && (
                        <p className="py-6 text-center text-13 text-[var(--text-secondary)]">
                          {label('noResults')}
                        </p>
                      )}
                    </>
                  ) : mode === 'emoji' ? (
                    <>
                      <div className="grid max-h-56 grid-cols-6 gap-1 overflow-y-auto p-1 sm:grid-cols-8">
                        {PROJECT_EMOJIS.map((item) => (
                          <Button
                            key={item}
                            variant="secondary"
                            tone={pickerIcon === item ? 'default' : 'quiet'}
                            className="h-10 w-full px-0 text-20"
                            aria-label={item}
                            aria-pressed={pickerIcon === item}
                            onClick={() => {
                              setCustomEmoji('');
                              setPickerIcon(item);
                            }}
                          >
                            {item}
                          </Button>
                        ))}
                      </div>
                      <Input
                        value={customEmoji}
                        onChange={(value) => {
                          setCustomEmoji(value);
                          if (validProjectIcon(value) && !value.includes(':')) setPickerIcon(value);
                        }}
                        placeholder={label('customEmoji')}
                        aria-label={label('customEmoji')}
                        maxLength={32}
                      />
                    </>
                  ) : mode === 'image' ? (
                    <div className="flex min-h-56 flex-col items-center justify-center gap-4 py-4">
                      <div className="flex size-24 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-hover-soft)]">
                        {draw(
                          pickerIcon,
                          isProjectImage(pickerIcon) || isProjectImageDraft(pickerIcon) ? 96 : 40,
                        )}
                      </div>
                      <Button disabled={busy || imageBusy} onClick={() => file.current?.click()}>
                        <ImagePlus size={16} />
                        {label('upload')}
                      </Button>
                      <p className="max-w-xs text-center text-12 text-[var(--text-secondary)]">
                        {label('imageHint')}
                      </p>
                    </div>
                  ) : (
                    <FormField label={label('letters')} hint={label('lettersHint')}>
                      {(control) => (
                        <Input
                          {...control}
                          value={letters}
                          onChange={(value) => {
                            setLetters(value);
                            if (validProjectIcon(`text:${value}`))
                              setPickerIcon(letterValue(value));
                          }}
                          maxLength={2}
                          placeholder="Aa"
                        />
                      )}
                    </FormField>
                  )}
                </div>
              )}
              {error || !available ? (
                <p role="alert" className="mt-4 text-13 text-[var(--text-secondary)]">
                  {error ?? label('unavailable')}
                </p>
              ) : null}
            </div>
            {!discard && (
              <div className="flex items-center justify-end gap-2 border-t border-[var(--border-default)] px-4 py-4">
                <Button variant="secondary" disabled={busy || imageBusy} onClick={close}>
                  {label('cancel')}
                </Button>
                <Button
                  variant="cta"
                  loading={busy || imageBusy}
                  disabled={
                    !available ||
                    (stage === 'profile'
                      ? !dirty ||
                        (create && (snapshot?.settingsVersion ?? 0) < 7 && !directory.trim())
                      : pickerInvalid)
                  }
                  onClick={() => {
                    if (stage === 'icon') {
                      setIcon(pickerIcon);
                      setStage('profile');
                      setError(null);
                    } else void save();
                  }}
                >
                  {label(stage === 'icon' ? 'applyIcon' : create ? 'createAction' : 'save')}
                </Button>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {remoteBrowse && project.deviceLinkDeviceId && (
        <AddRemoteProjectDialog
          open
          existingOnly
          fixedDeviceId={project.deviceLinkDeviceId}
          title={label(remoteBrowse === 'main' ? 'chooseExistingFolder' : 'addDirectory')}
          confirmText={label(remoteBrowse === 'main' ? 'chooseExistingFolder' : 'addDirectory')}
          onOpenChange={(open) => {
            if (!open) setRemoteBrowse(null);
          }}
          onProjectAdded={(target) => {
            if (target.kind !== 'device-link' || target.deviceId !== project.deviceLinkDeviceId)
              return;
            if (remoteBrowse === 'main') setDirectory(target.path);
            else
              setDirectories((previous) =>
                target.path === directory ||
                previous.length >= 10 ||
                previous.some((item) => item.path === target.path)
                  ? previous
                  : [...previous, { path: target.path, access: 'write' }],
              );
          }}
        />
      )}
    </>
  );
}
