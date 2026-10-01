import { Button } from '@/components/ui/button';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, ChevronDown, Plus } from 'lucide-react';
import cindyPortrait from '@/assets/bot-presets/cindy.png';
import { Tip } from '@/components/ui/tooltip';
import gallery from '../../../../resources/teammate-portrait-gallery.png';
import { BOT_AVATAR_MAX_BYTES } from '../../../shared/botAvatarValue';

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
  onUpload,
  onPreparingChange,
  trigger,
  fallback,
}: {
  value?: string;
  token?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Editing can retain the existing host-owned file chooser. */
  onUpload?: () => void;
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
  const file = useRef<HTMLInputElement>(null);
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
    setCandidate(undefined);
  }, [token]);
  useEffect(
    () => () => {
      generation.current++;
      setPreparing(false);
    },
    [],
  );
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
                  onClick={() => {
                    generation.current++;
                    setPreparing(false);
                    if (onUpload) {
                      setOpen(false);
                      onUpload();
                    } else file.current?.click();
                  }}
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
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            event.target.value = '';
            if (!selected) return;
            if (
              !['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) ||
              !selected.size ||
              selected.size > BOT_AVATAR_MAX_BYTES
            ) {
              setError(true);
              return;
            }
            if (disabled) return;
            const current = ++generation.current;
            setPreparing(true);
            try {
              const reader = new FileReader();
              reader.onload = () => {
                try {
                  if (current === generation.current) {
                    onChange(String(reader.result));
                    setError(false);
                    setOpen(false);
                  }
                } finally {
                  finishPreparing(current);
                }
              };
              reader.onerror = () => {
                if (current === generation.current) setError(true);
                finishPreparing(current);
              };
              reader.onabort = () => finishPreparing(current);
              reader.readAsDataURL(selected);
            } catch {
              if (current === generation.current) setError(true);
              finishPreparing(current);
            }
          }}
        />
      </div>
    </Popover.Root>
  );
}
