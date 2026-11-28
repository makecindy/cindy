import { useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ImagePlus, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';
import {
  CONNECTION_BRAND_OPTIONS, isProviderConnectionIcon, isProviderConnectionImage, type ConnectionArtwork,
} from '@cindy/model-providers/branding';
import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tip } from '@/components/ui/tooltip';
import { providerMonogram } from '@/lib/providerModels';
import { decodeResizedImage } from './avatarCropImage';
import { providersSettings } from './ProvidersSection.settings-search';
import { cn } from '@/lib/utils';

async function thumbnail(file: File) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
    throw new Error('unsupported image');
  }
  const source = await decodeResizedImage(file, 48);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 48;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    const scale = 48 / Math.max(source.width, source.height);
    const width = source.width * scale, height = source.height * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, (48 - width) / 2, (48 - height) / 2, width, height);
    const result = canvas.toDataURL('image/png');
    if (!isProviderConnectionImage(result)) throw new Error('invalid thumbnail');
    return result;
  } finally {
    source.close();
  }
}

export function ProviderAppearanceDialog({ provider, scope, onClose, writeAndReadback }: {
  provider: ProviderView;
  scope: { dataOwnerId: string | null; ownerGeneration: number };
  onClose: () => void;
  writeAndReadback?: (change: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const iconGroup = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [initial] = useState(() => ({
    name: provider.name,
    icon: isProviderConnectionImage(provider.customIcon) ? provider.customIcon
      : isProviderConnectionIcon(provider.logoKind) ? provider.logoKind : null,
  }));
  const [name, setName] = useState(initial.name);
  const [icon, setIcon] = useState<ConnectionArtwork | null>(initial.icon);
  const [image, setImage] = useState(isProviderConnectionImage(initial.icon) ? initial.icon : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = name.trim() !== initial.name || icon !== initial.icon;
  const choices: { value: ConnectionArtwork | null; label: string }[] = [
    { value: null, label: t('settings.providers.menu.connectionIcon.default') },
    { value: 'personal', label: t('settings.providers.menu.connectionIcon.personal') },
    { value: 'work', label: t('settings.providers.menu.connectionIcon.work') },
    ...(image ? [{ value: image, label: t('settings.providers.menu.ownImage') }] : []),
    ...CONNECTION_BRAND_OPTIONS,
  ];
  // Pin Cindy ahead of the connection-specific options, keeping every other choice in order.
  choices.sort((a, b) => Number(b.value === 'mark-cindy') - Number(a.value === 'mark-cindy'));

  function mark(value: ConnectionArtwork | null, size: number) {
    if (isProviderConnectionImage(value)) return <img src={value} width={size} height={size} alt="" />;
    if (value || hasProviderLogo(provider.id, provider.routing)) {
      return <ProviderLogoMark providerId={provider.id} routing={provider.routing} logoKind={value ?? undefined} size={size} />;
    }
    return <span>{providerMonogram(name)}</span>;
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const next = await thumbnail(file);
      setImage(next);
      setIcon(next);
    } catch {
      setError(t('settings.providers.menu.imageError'));
    } finally { setBusy(false); }
  }

  async function save() {
    if (busy || !changed || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const change = async () => {
        await window.electronAPI.maker.setProviderPresentation({
          ...scope, providerId: provider.id, action: 'appearance',
          ...(name.trim() !== initial.name ? { name: name.trim() } : {}),
          ...(icon !== initial.icon ? { icon } : {}),
        });
        onClose();
      };
      if (writeAndReadback) await writeAndReadback(change);
      else await change();
    } catch {
      setError(t('settings.providers.custom.toast.saveFailed'));
    } finally { setBusy(false); }
  }

  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
      <Dialog.Content
        aria-describedby={undefined}
        onPointerDownOutside={event => event.preventDefault()}
        className="modal-panel fixed left-1/2 top-1/2 z-modal-raised max-h-[85vh] w-[min(512px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 text-[var(--text-primary)]"
      >
        <Dialog.Title className="mb-5 text-18 font-semibold">{t('settings.providers.menu.appearance')}</Dialog.Title>
        <form onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy} className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">{mark(icon, 36)}</div>
              <div className="min-w-0 flex-1">
                <label htmlFor={nameId} className="mb-1 block text-13 font-medium">{t('settings.providers.wizard.nameLabel')}</label>
                <Input data-setting-id={providersSettings.providers.id} id={nameId} value={name} onChange={setName} maxLength={128} />
              </div>
            </div>
            <fieldset>
              <legend className="mb-2 text-13 font-medium">{t('settings.providers.menu.icon')}</legend>
              <div className="grid max-h-[clamp(7rem,calc(85vh_-_20rem),24rem)] grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1 overflow-y-auto rounded-xl border border-[var(--border-default)] p-2">
                {choices.map(({ value, label }) => (
                  <Tip key={value ?? 'default'} text={label}>
                    <label className={cn(
                      'relative flex h-11 items-center justify-center rounded-lg border border-transparent hover:bg-[var(--surface-hover)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2',
                      icon === value && 'border-[var(--text-primary)] bg-[var(--surface-hover)]',
                    )}>
                      <input data-setting-id={providersSettings.providers.id} type="radio" name={iconGroup}
                        aria-label={label} checked={icon === value} onChange={() => setIcon(value)}
                        className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
                      {value === null ? <RotateCcw aria-hidden size={20} /> : mark(value, 22)}
                      {icon === value && <Check aria-hidden size={10} className="pointer-events-none absolute right-1 top-1" />}
                    </label>
                  </Tip>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-wrap items-center gap-2">
              <Button data-setting-id={providersSettings.providers.id} type="button" variant="secondary" size="md" onClick={() => fileRef.current?.click()}>
                <ImagePlus size={16} />{t('settings.providers.menu.ownImage')}
              </Button>
              <span className="text-12 text-[var(--text-tertiary)]">PNG · JPG · WebP</span>
              <input data-setting-id={providersSettings.providers.id} hidden ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void chooseFile(file);
              }} />
            </div>
          </fieldset>
          {error && <p role="alert" className="mt-3 text-13 text-[var(--error-text)]">{error}</p>}
          <div className="mt-6 flex justify-end gap-2">
            <Button data-settings-search-action="Discard this connection appearance draft" type="button" variant="secondary" size="md" disabled={busy} onClick={onClose}>{t('settings.providers.custom.cancel')}</Button>
            <Button data-settings-search-action="Save the connection name and icon" type="submit" variant="primary" size="md" disabled={busy || !name.trim() || !changed}>{t('settings.providers.custom.save')}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
