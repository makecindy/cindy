import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Check, ChevronDown } from 'lucide-react';
import gallery from '../../../../resources/teammate-portrait-gallery.png';
import { Spinner } from '@/components/ui/spinner';
import { BOT_AVATAR_MAX_BYTES } from '../../../shared/botAvatarValue';

export async function galleryPortrait(index: number): Promise<string> {
  const image = new Image();
  image.src = gallery;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Portrait unavailable');
  ctx.drawImage(
    image,
    ((index % 4) * image.width) / 4,
    (Math.floor(index / 4) * image.height) / 4,
    image.width / 4,
    image.height / 4,
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
}: {
  value?: string;
  token?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState<string>();
  const [error, setError] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const currentToken = useRef(token);
  useEffect(() => {
    currentToken.current = token;
    setCandidate(undefined);
  }, [token]);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const select = async (index: number) => {
    if (disabled) return;
    const current = ++generation.current;
    try {
      const portrait = await galleryPortrait(index);
      if (current !== generation.current) return;
      onChange(portrait);
      setOpen(false);
      setError(false);
    } catch {
      setError(true);
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
        <Popover.Trigger asChild>
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
              <Camera size={24} />
            )}
            <span className="absolute bottom-0 right-0 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)]">
              <ChevronDown size={14} />
            </span>
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={12}
            className="z-[60] w-72 max-w-[calc(100vw-80px)] rounded-xl border border-[var(--border-default)] bg-[var(--confirm-bg)] p-3"
          >
            <div className="grid grid-cols-4 gap-2">
              {Array.from({ length: 16 }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  aria-label={t('bots.guided.portrait', { number: index + 1 })}
                  onClick={() => void select(index)}
                  className="aspect-square rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  style={{
                    backgroundImage: `url(${gallery})`,
                    backgroundSize: '400% 400%',
                    backgroundPosition: `${((index % 4) * 100) / 3}% ${(Math.floor(index / 4) * 100) / 3}%`,
                  }}
                />
              ))}
            </div>
            <div className="mt-3 flex gap-1 border-t border-[var(--border-default)] pt-2">
              <button
                type="button"
                onClick={() => file.current?.click()}
                className="h-9 flex-1 rounded-full text-12 hover:bg-[var(--surface-hover)]"
              >
                {t('bots.guided.upload')}
              </button>
              {token && <button
                type="button"
                disabled={busy}
                onClick={() => void generate()}
                className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-full text-12 hover:bg-[var(--surface-hover)] disabled:opacity-50"
              >
                {busy && <Spinner size={12} />}
                {t('bots.guided.generateAvatar')}
              </button>}
            </div>
            {candidate && (
              <button
                type="button"
                onClick={() => {
                  onChange(candidate);
                  setOpen(false);
                }}
                className="mt-2 flex w-full items-center gap-3 rounded-full p-1 text-12 hover:bg-[var(--surface-hover)]"
              >
                <img src={candidate} alt="" className="h-10 w-10 rounded-full" />
                <span>{t('bots.guided.useAvatar')}</span>
                <Check size={14} />
              </button>
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
            const current = ++generation.current;
            const reader = new FileReader();
            reader.onload = () => {
              if (current === generation.current) {
                onChange(String(reader.result));
                setError(false);
                setOpen(false);
              }
            };
            reader.onerror = () => setError(true);
            reader.readAsDataURL(selected);
          }}
        />
      </div>
    </Popover.Root>
  );
}
