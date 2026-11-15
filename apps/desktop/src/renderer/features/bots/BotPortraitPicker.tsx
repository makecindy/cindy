import { Button } from '@/components/ui/button';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, ChevronDown, Plus } from 'lucide-react';
import cindyPortrait from '@/assets/bot-presets/cindy.png';
import { Tip } from '@/components/ui/tooltip';
import gallery from '../../../../resources/teammate-portrait-gallery.png';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { AvatarCropEditor } from '@/components/settings/AvatarCropEditor';
import { initialAvatarCrop, type AvatarCrop } from '@/components/settings/avatarCropGeometry';
import {
  loadAvatarSource,
  exportAvatarCrop,
  type AvatarSource,
} from '@/components/settings/avatarCropImage';

export const BOT_PORTRAIT_COUNT = 17;

/** Cindy first, followed by the original 4×4 sheet in its existing order. */
export async function galleryPortrait(index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0 || index >= BOT_PORTRAIT_COUNT) {
    throw new Error('Unknown portrait');
  }
  const image = new Image();
  image.src = index === 0 ? cindyPortrait : gallery;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Portrait unavailable');
  const cell = index - 1;
  ctx.drawImage(
    image,
    index === 0 ? 0 : ((cell % 4) * image.width) / 4,
    index === 0 ? 0 : (Math.floor(cell / 4) * image.height) / 4,
    index === 0 ? image.width : image.width / 4,
    index === 0 ? image.height : image.height / 4,
    0,
    0,
    256,
    256,
  );
  return canvas.toDataURL('image/png');
}

export function BotPortraitPicker({
  value,
  token,
  disabled,
  onChange,
  onPreparingChange,
  trigger,
  fallback,
}: {
  value?: string;
  token?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Synchronous navigation guard while decoding a selection or reading a file. */
  onPreparingChange?: (pending: boolean) => void;
  trigger?: ReactElement;
  /** Current avatar artwork or glyph when there is no image draft. */
  fallback?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<string>();
  const [error, setError] = useState(false);
  const [cropSession, setCropSession] = useState<{ source: AvatarSource; crop: AvatarCrop } | null>(
    null,
  );
  const cropRef = useRef(cropSession);
  cropRef.current = cropSession;
  const exporting = useRef(false);
  const [exportBusy, setExportBusy] = useState(false);
  const choosing = useRef(false);
  const generation = useRef(0);
  const currentToken = useRef(token);
  const preparing = useRef(false);
  const preparingChange = useRef(onPreparingChange);
  preparingChange.current = onPreparingChange;
  const setPreparing = (pending: boolean) => {
    if (preparing.current === pending) return;
    preparing.current = pending;
    preparingChange.current?.(pending);
  };
  const finishPreparing = (request: number) => {
    if (request === generation.current) setPreparing(false);
  };
  useEffect(() => {
    currentToken.current = token;
    choosing.current = false;
    generation.current++;
    cropRef.current?.source.bitmap.close();
    cropRef.current = null;
    setCropSession(null);
    setPreparing(false);
    setCandidate(undefined);
  }, [token]);
  useEffect(
    () => () => {
      generation.current++;
      cropRef.current?.source.bitmap.close();
      cropRef.current = null;
      setPreparing(false);
    },
    [],
  );
  const cancelCrop = () => {
    cropRef.current?.source.bitmap.close();
    cropRef.current = null;
    setCropSession(null);
    setPreparing(false);
  };
  const confirmCrop = async () => {
    const session = cropRef.current;
    if (!session || exporting.current) return;
    exporting.current = true;
    setExportBusy(true);
    try {
      const output = await exportAvatarCrop(session.source, session.crop);
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Avatar read failed'));
        reader.onabort = () => reject(new Error('Avatar read aborted'));
        reader.readAsDataURL(output.blob);
      });
      if (cropRef.current !== session) return;
      onChange(dataUrl);
      cancelCrop();
    } catch {
      if (cropRef.current === session) setError(true);
    } finally {
      exporting.current = false;
      setExportBusy(false);
    }
  };
  const chooseUpload = async () => {
    if (disabled || choosing.current) return;
    const request = ++generation.current;
    choosing.current = true;
    setPreparing(true);
    setError(false);
    setOpen(false);
    try {
      // Bot source preparation shares account avatars' HDR conversion but is
      // local-only: local-mode users do not need a Cindy account to pick a file.
      const result = await window.electronAPI.localDb.bots.chooseAvatarSource();
      if (request !== generation.current || result.canceled || !result.previewDataUrl) return;
      const source = await loadAvatarSource(result.previewDataUrl);
      if (request !== generation.current) {
        source.bitmap.close();
        return;
      }
      cropRef.current?.source.bitmap.close();
      const session = { source, crop: initialAvatarCrop(source.size) };
      cropRef.current = session;
      setCropSession(session);
    } catch {
      if (request === generation.current) {
        setError(true);
        setOpen(true);
      }
    } finally {
      if (request === generation.current) choosing.current = false;
      if (!cropRef.current) finishPreparing(request);
    }
  };
  const select = async (index: number) => {
    if (disabled) return;
    const current = ++generation.current;
    setPreparing(true);
    try {
      const portrait = await galleryPortrait(index);
      if (current !== generation.current) return;
      onChange(portrait);
      setOpen(false);
      setError(false);
    } catch {
      if (current === generation.current) setError(true);
    } finally {
      finishPreparing(current);
    }
  };
  const generate = async () => {
    if (busy || disabled || !token) return;
    setBusy(true);
    setError(false);
    try {
      const result = await window.electronAPI.localDb.bots.generateAvatar(token);
      if (currentToken.current === token)
        setCandidate(`data:image/png;base64,${result.avatarImageBase64}`);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <div className="relative shrink-0">
        <Tip text={t(disabled ? 'bots.autosave.saving' : 'bots.profile.changeAvatar')}>
          <Popover.Trigger asChild>
            {trigger ?? (
              <button
                type="button"
                disabled={disabled}
                aria-expanded={open}
                aria-label={t('bots.profile.changeAvatar')}
                className="relative flex h-24 w-24 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {value ? (
                  <img src={value} alt="" className="h-full w-full rounded-full object-cover" />
                ) : (
                  (fallback ?? <Camera size={24} />)
                )}
                <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)]">
                  <ChevronDown size={14} />
                </span>
              </button>
            )}
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={12}
            collisionPadding={16}
            className="z-[60] w-[360px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-3"
          >
            <div className="grid grid-cols-4 gap-2 min-[400px]:grid-cols-6">
              {Array.from({ length: BOT_PORTRAIT_COUNT }, (_, index) => {
                const label = index === 0 ? 'Cindy' : t('bots.guided.portrait', { number: index });
                const cell = index - 1;
                return (
                  <Tip key={index} text={label}>
                    <button
                      type="button"
                      aria-label={label}
                      onClick={() => void select(index)}
                      className="aspect-square rounded-full outline-none ring-offset-2 ring-offset-[var(--confirm-bg)] hover:ring-1 hover:ring-[var(--border-default)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                      style={{
                        backgroundImage: `url(${index === 0 ? cindyPortrait : gallery})`,
                        backgroundSize: index === 0 ? 'cover' : '400% 400%',
                        backgroundPosition:
                          index === 0
                            ? 'center'
                            : `${((cell % 4) * 100) / 3}% ${(Math.floor(cell / 4) * 100) / 3}%`,
                      }}
                    />
                  </Tip>
                );
              })}
              <Tip text={t('bots.guided.upload')}>
                <button
                  type="button"
                  aria-label={t('bots.guided.upload')}
                  onClick={() => void chooseUpload()}
                  className="flex aspect-square items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  <Plus size={20} aria-hidden="true" />
                </button>
              </Tip>
            </div>
            {token && (
              <div className="mt-3 flex gap-1 border-t border-[var(--border-default)] pt-2">
                <Button
                  variant="secondary"
                  size="lg"
                  tone="quiet"
                  loading={busy}
                  type="button"
                  disabled={busy}
                  onClick={() => void generate()}
                  className="flex-1"
                >
                  {t('bots.guided.generateAvatar')}
                </Button>
              </div>
            )}
            {candidate && (
              <Button
                variant="secondary"
                size="sm"
                compact
                tone="quiet"
                type="button"
                onClick={() => {
                  onChange(candidate);
                  setOpen(false);
                }}
                className="mt-2 w-full h-auto min-h-12 justify-start p-1 gap-3"
              >
                <img src={candidate} alt="" className="h-10 w-10 rounded-full" />
                <span>{t('bots.guided.useAvatar')}</span>
                <Check size={14} />
              </Button>
            )}
            {error && (
              <p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">
                {t('bots.profile.avatarSelectionFailed')}
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
        {cropSession && (
          <ConfirmDialog
            open
            onOpenChange={(next) => {
              if (!next && !exporting.current) cancelCrop();
            }}
            title={t('settings.userProfile.edit.crop.title')}
            description={t('settings.userProfile.edit.crop.description')}
            confirmText={t('settings.userProfile.edit.crop.done')}
            cancelText={t('settings.userProfile.edit.cancel')}
            loading={exportBusy}
            onConfirm={() => void confirmCrop()}
            content={
              <>
                <AvatarCropEditor
                  source={cropSession.source}
                  crop={cropSession.crop}
                  onCropChange={(crop) => {
                    if (exporting.current || !cropRef.current) return;
                    const next = { ...cropRef.current, crop };
                    cropRef.current = next;
                    setCropSession(next);
                  }}
                  tipClassName="z-[10001]"
                />
                {error && (
                  <p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">
                    {t('settings.userProfile.edit.crop.exportFailed')}
                  </p>
                )}
              </>
            }
          />
        )}
      </div>
    </Popover.Root>
  );
}
