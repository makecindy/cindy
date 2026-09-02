import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

import { useBotTranslation } from './botPronounContext';
import { BotAvatar } from './BotAvatar';
import { DEFAULT_PERSONA_SELECTION, PersonaEditorFields } from './BotPersonaWizard';
import {
  compilePersonaIntoIdentitySource,
  extractPersonaFromIdentitySource,
  readBotBackground,
  writeBotBackground,
  type PersonaSelection,
} from './botPersona';

export interface BotProfileDialogValue {
  name: string;
  description: string;
  identitySource: string;
  avatar: string;
  avatarColor: string;
}

interface BotProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: BotProfileDialogValue;
  mode: 'create' | 'edit';
  onSave: (value: BotProfileDialogValue) => void | Promise<void>;
}

export function BotProfileDialog({
  open,
  onOpenChange,
  value,
  mode,
  onSave,
}: BotProfileDialogProps) {
  const { t } = useBotTranslation();
  const [name, setName] = useState(value.name);
  const [description, setDescription] = useState(value.description);
  const [background, setBackground] = useState(() => readBotBackground(value.identitySource));
  const [personality, setPersonality] = useState('');
  const [avatar, setAvatar] = useState(value.avatar);
  const [avatarColor, setAvatarColor] = useState(value.avatarColor);
  const [persona, setPersona] = useState<PersonaSelection>(DEFAULT_PERSONA_SELECTION);
  const [personaConfigured, setPersonaConfigured] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const parsedPersona = extractPersonaFromIdentitySource(value.identitySource);
    setName(value.name);
    setDescription(value.description);
    setBackground(readBotBackground(value.identitySource));
    setPersonality('');
    setAvatar(value.avatar);
    setAvatarColor(value.avatarColor);
    setPersona(parsedPersona ?? DEFAULT_PERSONA_SELECTION);
    setPersonaConfigured(parsedPersona !== null);
    setError(null);
  }, [
    mode,
    open,
    value.avatar,
    value.avatarColor,
    value.description,
    value.identitySource,
    value.name,
  ]);

  const handleSave = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const nextIdentitySource = isCreate
        ? [background.trim(), personality.trim()].filter(Boolean).join('\n\n')
        : writeBotBackground(value.identitySource, background);
      await onSave({
        name: name.trim(),
        description: description.trim(),
        identitySource: personaConfigured
          ? compilePersonaIntoIdentitySource(nextIdentitySource, persona)
          : nextIdentitySource,
        avatar,
        avatarColor,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const isCreate = mode === 'create';
  const closeWithoutSaving = () => {
    onOpenChange(false);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else closeWithoutSaving();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--overlay-modal)]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[min(640px,calc(100vh-48px))] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-6 outline-none">
          <Dialog.Title className="text-16 font-medium text-[var(--text-primary)]">
            {isCreate ? t('bots.roster.customTitle') : t('bots.editProfile')}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-12 text-[var(--text-secondary)]">
            {isCreate ? t('bots.roster.customIntro') : t('bots.editProfileDescription')}
          </Dialog.Description>
          {isCreate ? (
            <div className="mt-6 flex flex-col gap-5">
              <div className="flex items-center gap-3">
                <BotAvatar bot={{ name, avatar, avatarColor }} size="lg" />
                <label className="min-w-0 flex-1 text-12 text-[var(--text-secondary)]">
                  <span className="mb-1.5 block">{t('bots.nameLabel')}</span>
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('bots.roster.customNamePlaceholder')}
                    className="h-10 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.descriptionLabel')}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('bots.roster.generate.inputPlaceholder')}
                  className="h-10 rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 text-14 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.background.title')}
                <textarea
                  value={background}
                  onChange={(event) => setBackground(event.target.value)}
                  placeholder={t('bots.background.placeholder')}
                  rows={5}
                  className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5 text-13 leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.persona.title')}
                <textarea
                  aria-label={t('bots.persona.title')}
                  value={personality}
                  onChange={(event) => setPersonality(event.target.value)}
                  placeholder={t('bots.persona.freeformPlaceholder')}
                  rows={3}
                  className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2.5 text-13 leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)] focus:border-[var(--focus-ring)]"
                />
                <span className="text-11 leading-4 text-[var(--text-tertiary)]">
                  {t('bots.persona.freeformHint')}
                </span>
              </label>
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-5">
              <div className="flex items-center gap-4 rounded-xl bg-[var(--surface-chip)] p-3">
                <BotAvatar bot={{ name, avatar, avatarColor }} size="xl" />
              </div>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.nameLabel')}
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('bots.namePlaceholder')}
                  className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.descriptionLabel')}
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('bots.descriptionPlaceholder')}
                  className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                />
              </label>
              <label className="flex flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
                {t('bots.background.title')}
                <textarea
                  value={background}
                  onChange={(event) => setBackground(event.target.value)}
                  rows={6}
                  className="resize-y rounded-xl border border-[var(--border-default)] bg-[var(--surface)] px-3 py-2 text-13 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
                />
              </label>
              <PersonaEditorFields
                style={persona.style}
                proactivity={persona.proactivity}
                call={persona.call}
                customCall={persona.customCall ?? ''}
                onStyleChange={(next) => {
                  setPersonaConfigured(true);
                  setPersona((current) => ({ ...current, style: next }));
                }}
                onProactivityChange={(next) => {
                  setPersonaConfigured(true);
                  setPersona((current) => ({ ...current, proactivity: next }));
                }}
                onCallChange={(next) => {
                  setPersonaConfigured(true);
                  setPersona((current) => ({ ...current, call: next }));
                }}
                onCustomCallChange={(next) => {
                  setPersonaConfigured(true);
                  setPersona((current) => ({ ...current, customCall: next }));
                }}
              />
            </div>
          )}
          {error ? (
            <p className="mt-3 text-11 text-[var(--text-danger)]" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={closeWithoutSaving}
              className="h-9 rounded-lg px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              {t('bots.cancel')}
            </button>
            <button
              type="button"
              disabled={!name.trim() || saving}
              onClick={() => void handleSave()}
              className="h-9 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)] disabled:opacity-50"
            >
              {saving
                ? t('bots.autosave.saving')
                : isCreate
                  ? t('bots.roster.create')
                  : t('bots.save')}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
