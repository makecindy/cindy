import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { isDurableCreationDraft } from './durableOutbox';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import { recoverUnconfirmedCreationDrafts } from './newSessionCreation';

const offered = new Set<string>();

/** Tell the owner a failed create can be reopened. Match the draft flag, not translated error text. */
export function UnconfirmedCreationNotice() {
  const focused = useIsFocused();
  const router = useRouter();
  const { t } = useTranslation();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  useEffect(() => {
    if (!focused) return;
    let active = true;
    const scan = () => {
      if (!active || !focusedRef.current) return;
      const owner = getMobileAuthOwner();
      void recoverUnconfirmedCreationDrafts().then(() => {
        if (!active || !focusedRef.current || !isMobileAuthOwnerCurrent(owner)) return;
        const record = getCurrentMobileOutboxRecords().find((item) =>
          isDurableCreationDraft(item) && !offered.has(item.item.sessionId));
        if (!record?.creation) return;
        offered.add(record.item.sessionId);
        Alert.alert(
          t('session.screen.createFailedTitle'),
          t('session.screen.firstMessageNotSent'),
          [
            { text: t('session.common.cancel'), style: 'cancel' },
            {
              text: t('session.screen.retry'),
              onPress: () => {
                router.push({
                  pathname: '/sessions/new',
                  params: {
                    recoverySessionId: record.item.sessionId,
                    deviceId: record.deviceId,
                    deviceName: record.creation?.deviceName ?? '',
                  },
                });
              },
            },
          ],
        );
      }).catch(() => undefined);
    };
    const unsubscribe = mobileDurableOutbox.subscribe(scan);
    scan();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [focused, router, t]);
  return null;
}
