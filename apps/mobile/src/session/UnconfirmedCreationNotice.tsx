import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useIsFocused } from '@react-navigation/native';
import { i18n } from '@/i18n';
import { isDurableCreationDraft } from './durableOutbox';
import { getCurrentMobileOutboxRecords } from './mobileDurableOutbox';
import { recoverUnconfirmedCreationDrafts } from './newSessionCreation';

const offered = new Set<string>();

/** Tell the owner a create never reached the host, and put the draft back in the form. */
export function UnconfirmedCreationNotice() {
  const focused = useIsFocused();
  const router = useRouter();
  const { t } = useTranslation();
  const running = useRef(false);
  useEffect(() => {
    if (!focused || running.current) return;
    running.current = true;
    void recoverUnconfirmedCreationDrafts().then((sessionIds) => {
      const notSent = i18n.t('session.screen.firstMessageNotSent');
      const record = getCurrentMobileOutboxRecords().find((item) =>
        !offered.has(item.item.sessionId)
        && (sessionIds.includes(item.item.sessionId)
          || (isDurableCreationDraft(item) && item.error === notSent)));
      if (!record?.creation) return;
      const sessionId = record.item.sessionId;
      offered.add(sessionId);
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
                  recoverySessionId: sessionId,
                  deviceId: record.deviceId,
                  deviceName: record.creation?.deviceName ?? '',
                },
              });
            },
          },
        ],
      );
    }).finally(() => { running.current = false; });
  }, [focused, router, t]);
  return null;
}
