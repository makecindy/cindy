import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  Check,
  Pencil,
  ChevronDown,
  Copy,
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
export function projectHostKey(project: ProjectNode): string {
  if (!project.deviceLinkDeviceId) return project.projectKey;
  const hosts = new Set(project.sessions.map((session) => session.remoteHostId ?? null));
  if (hosts.size > 1) return '';
  const host = hosts.values().next().value;
  return host
    ? `remote:${encodeURIComponent(host)}:${project.workingDir}`
    : `local:${project.workingDir}`;
}

export function ProjectSettingsDialog({
  project,
  onClose,
}: {
  project: ProjectNode;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`projectSettings.${key}`);
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
  const key = projectHostKey(project);
  const automatic = useAutomaticProjectIcon(
    key,
    project.deviceLinkDeviceId,
    (snapshot?.settingsVersion ?? 0) >= 4,
  );
  const defaultName = projectDirectoryName(project.workingDir);
  const [name, setName] = useState(project.displayName);
  const [editingName, setEditingName] = useState(false);
  const nameBeforeEdit = useRef(name);
  const nameButton = useRef<HTMLButtonElement>(null);
  const finishNameEditing = () => {
    setEditingName(false);
    requestAnimationFrame(() => nameButton.current?.focus());
  };
  const [icon, setIcon] = useState<string | null>(null);
  const [initial, setInitial] = useState<{ name: string; icon: string | null } | null>(null);
  useEffect(() => {
    if (snapshot && !initial) {
      const next = resolveProjectIcon(snapshot, key);
      setInitial({ name: project.displayName, icon: next });
      setIcon(next);
    }
  }, [snapshot, initial, key, project.displayName]);
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
  const [discard, setDiscard] = useState(false);
  const [copied, setCopied] = useState(false);
  const lock = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const [owner] = useState(getDataOwnerGeneration);
  const available = !!key && !!initial && (snapshot?.settingsVersion ?? 0) >= 2;
  const dirty = !!initial && (name.trim() !== initial.name || icon !== initial.icon);
  const close = () => {
    if (busy || imageBusy) return;
    if (stage === 'icon') {
      setStage('profile');
      setError(null);
      return;
    }
    if (dirty) setDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (
      lock.current ||
      !available ||
      !dirty ||
      !snapshot?.ownerStamp ||
      !isDataOwnerGenerationCurrent(owner)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const value: { name?: string; icon?: string | null } = {};
    if (name.trim() !== initial!.name) value.name = name.trim() === defaultName ? '' : name.trim();
    if (icon !== initial!.icon) value.icon = icon;
    try {
      const request = { projectKey: key, field: 'profile' as const, value, ...snapshot.ownerStamp };
      if (project.deviceLinkDeviceId) {
        await window.electronAPI.deviceLink.invoke(
          project.deviceLinkDeviceId,
          PROJECT_SETTINGS_SET_CHANNEL,
          [request],
        );
        if ('name' in value && isDataOwnerGenerationCurrent(owner))
          await window.electronAPI.localDb.projectAliases.delete(project.projectKey);
      } else await window.electronAPI.localDb.projectAliases.updateInfo(request);
      if (isDataOwnerGenerationCurrent(owner)) onClose();
    } catch {
      setError(label('failed'));
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
    setEditingName(false);
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
      automaticEnabled={(snapshot?.settingsVersion ?? 0) >= 4}
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
  return (
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
          onEscapeKeyDown={(event) => {
            if (editingName) {
              event.preventDefault();
              setName(nameBeforeEdit.current);
              finishNameEditing();
            }
          }}
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
              {label(stage === 'icon' ? 'chooseIcon' : 'title')}
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
          <Dialog.Description className="sr-only">{label('nameHint')}</Dialog.Description>
          <div className="min-h-0 overflow-y-auto px-4 pb-6">
            {discard ? (
              <div className="flex flex-col gap-4 py-4">
                <p className="text-15 text-[var(--text-primary)]">{label('discardHint')}</p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setDiscard(false)}>{label('keepEditing')}</Button>
                  <Button variant="cta" onClick={onClose}>
                    {label('discard')}
                  </Button>
                </div>
              </div>
            ) : stage === 'profile' ? (
              <div className="flex flex-col gap-6">
                <div className="flex items-center gap-4 py-2">
                  <button
                    type="button"
                    disabled={!available || busy}
                    onClick={openPicker}
                    aria-label={label('changeIcon')}
                    className="group relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-hover-soft)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    {draw(icon, isProjectImage(icon) || isProjectImageDraft(icon) ? 64 : 36)}
                    <span
                      className="absolute bottom-0 right-0 flex size-6 items-center justify-center rounded-tl-lg bg-[var(--surface-elevated)] text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden="true"
                    >
                      <Pencil size={13} />
                    </span>
                  </button>
                  <div className="min-w-0 flex-1">
                    {editingName ? (
                      <Input
                        aria-label={label('name')}
                        value={name}
                        placeholder={defaultName}
                        maxLength={80}
                        disabled={busy || !available}
                        onChange={setName}
                        autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={() => setEditingName(false)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            finishNameEditing();
                          }
                        }}
                        inputClassName="text-20 font-medium"
                      />
                    ) : (
                      <button
                        ref={nameButton}
                        type="button"
                        aria-label={label('name')}
                        disabled={busy || !available}
                        onClick={() => {
                          nameBeforeEdit.current = name;
                          setEditingName(true);
                        }}
                        className="group flex min-h-9 max-w-full items-center gap-2 rounded-full text-left text-20 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      >
                        <span className="truncate">{name.trim() || defaultName}</span>
                        <Pencil
                          size={14}
                          aria-hidden="true"
                          className="shrink-0 text-[var(--text-secondary)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        />
                      </button>
                    )}
                    {name !== defaultName && (
                      <Button
                        variant="secondary"
                        tone="quiet"
                        size="sm"
                        className="-ml-3 mt-1"
                        disabled={busy || !available}
                        onClick={() => setName(defaultName)}
                      >
                        <RotateCcw size={13} />
                        {label('reset')}
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-12 text-[var(--text-secondary)]">{label('nameHint')}</p>
                {(snapshot?.settingsVersion ?? 0) >= 4 &&
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
                <div className="flex flex-col gap-3 border-t border-[var(--border-default)] pt-5">
                  <div className="flex items-center gap-2 text-13 text-[var(--text-secondary)]">
                    <Monitor size={15} />
                    <span>{project.deviceLinkDeviceName || label('thisComputer')}</span>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="mb-1 text-13 text-[var(--text-secondary)]">
                        {label('directory')}
                      </p>
                      <p className="select-text break-all text-13 leading-relaxed text-[var(--text-primary)]">
                        {project.workingDir}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      tone="quiet"
                      className="w-8 shrink-0 px-0"
                      aria-label={label(copied ? 'copied' : 'copy')}
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(project.workingDir)
                          .then(() => setCopied(true))
                          .catch(() => setError(label('failed')))
                      }
                    >
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                    </Button>
                  </div>
                </div>
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
                            parseProjectSymbol(pickerIcon)?.name === item.name ? 'default' : 'quiet'
                          }
                          className="h-10 w-full px-0"
                          aria-label={item.name}
                          aria-pressed={parseProjectSymbol(pickerIcon)?.name === item.name}
                          onClick={() => setPickerIcon(projectSymbolValue(item.name, pickerColor))}
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
                          if (validProjectIcon(`text:${value}`)) setPickerIcon(letterValue(value));
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
                disabled={!available || (stage === 'profile' ? !dirty : pickerInvalid)}
                onClick={() => {
                  if (stage === 'icon') {
                    setIcon(pickerIcon);
                    setStage('profile');
                    setError(null);
                  } else void save();
                }}
              >
                {label(stage === 'icon' ? 'applyIcon' : 'save')}
              </Button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
