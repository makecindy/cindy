import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Input } from '@/components/ui/input';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  isProviderManagementOutdated,
  providerShareManagementCommand,
} from '@/features/provider-group/providerManagement';

import type { ProviderShareMemberView } from '../../../shared/providerShare';
import {
  normalizeProviderShareMemberNote,
  PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH,
} from '../../../shared/providerShareMemberNote';
import {
  ProviderShareDialog,
  ProviderShareDialogFooter,
  ProviderShareDialogTitle,
} from './ProviderShareDialog';

export function ProviderShareMemberNoteDialog({
  member,
  deviceId,
  returnFocusTo,
  onSaved,
  onClose,
}: {
  member: ProviderShareMemberView;
  deviceId?: string;
  returnFocusTo?: HTMLElement | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(member.note ?? '');
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      requestSeq.current += 1;
    },
    [],
  );

  const save = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const seq = ++requestSeq.current;
    const owner = getDataOwnerGeneration();
    const current = () => seq === requestSeq.current && isDataOwnerGenerationCurrent(owner);
    setSaving(true);
    setErrorKey(null);
    try {
      await providerShareManagementCommand(
        {
          action: 'set-member-note',
          memberId: member.memberId,
          note: normalizeProviderShareMemberNote(note),
        },
        deviceId,
      );
      if (current()) onSaved();
    } catch (error) {
      if (current())
        setErrorKey(
          deviceId && isProviderManagementOutdated(error)
            ? 'providerGroup.management.unsupported'
            : 'providerShare.manage.memberNote.saveFailed',
        );
    } finally {
      if (current()) {
        inFlight.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <ProviderShareDialog
      open
      busy={saving}
      initialFocusRef={inputRef}
      returnFocusTo={returnFocusTo}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ProviderShareDialogTitle>
        {t('providerShare.manage.memberNote.title')}
      </ProviderShareDialogTitle>
      <p className="mt-2 select-text text-13 leading-[1.5] text-[var(--confirm-desc)]">
        {t('providerShare.manage.memberNote.username', { name: member.displayName })}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label
          htmlFor="provider-share-member-note"
          className="mb-2 mt-4 block text-13 font-medium leading-[1.5] text-[var(--text-primary)]"
        >
          {t('providerShare.manage.memberNote.label')}
        </label>
        <Input
          inputRef={inputRef}
          id="provider-share-member-note"
          value={note}
          maxLength={PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH}
          disabled={saving}
          onChange={setNote}
          aria-describedby="provider-share-member-note-hint"
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229))
              event.preventDefault();
          }}
        />
        <p
          id="provider-share-member-note-hint"
          className="mt-2 text-12 leading-[1.5] text-[var(--text-secondary)]"
        >
          {t('providerShare.manage.memberNote.hint', {
            count: PROVIDER_SHARE_MEMBER_NOTE_MAX_LENGTH,
          })}
        </p>
        {errorKey && <ErrorNotice role="alert" className="mt-3" message={t(errorKey)} />}
        <ProviderShareDialogFooter>
          <Button
            type="submit"
            variant="primary"
            palette="confirmation"
            size="lg"
            disabled={saving}
          >
            {t(
              saving
                ? 'providerShare.manage.memberNote.saving'
                : 'providerShare.manage.memberNote.save',
            )}
          </Button>
          <Button
            type="button"
            variant="secondary"
            palette="confirmation"
            size="lg"
            disabled={saving}
            onClick={onClose}
          >
            {t('settings.providers.button.cancel')}
          </Button>
        </ProviderShareDialogFooter>
      </form>
    </ProviderShareDialog>
  );
}
