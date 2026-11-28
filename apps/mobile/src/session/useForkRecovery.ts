import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { randomUUID } from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { useTranslation } from 'react-i18next';
import type { ForkRequest, ForkTarget, ForkOutcome } from '@cindy/maker-shared/fork-request';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteSession } from '@/session/types';
import type { MobileMessageDraft } from './MessageRenderer';
import { formatRemoteError } from '@/device-link/remoteStatus';

/** UI state only. Host receipts own creation and deduplication across lost responses. */
export function useForkRecovery(input: {
  scope: string; storageScope: string; sessionId: string; maker: MobileMakerTransport;
  setPickerOpen(open: boolean): void;
  onBusy(clientId: string | null): void;
  onError(message: string): void;
  onComplete(session: RemoteSession, draft: MobileMessageDraft | undefined, outcome?: ForkOutcome): void;
}) {
  const { t } = useTranslation();
  const current = useRef(input);
  current.current = input;
  const active = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const request = useRef<{ scope: string; value: ForkRequest } | undefined>(undefined);
  const selection = useRef<{ scope: string; clientId: string; draft?: MobileMessageDraft;
    owner: ReturnType<typeof getMobileAuthOwner> } | undefined>(undefined);
  const pickedTarget = useRef<ForkTarget | undefined>(undefined);
  const run = async (clientId: string, draft?: MobileMessageDraft, target?: ForkTarget, checkOnly = false) => {
    if (active.current === input.scope) return;
    const captured = input;
    const owner = getMobileAuthOwner();
    const isCurrent = () => alive.current && current.current.scope === captured.scope && isMobileAuthOwnerCurrent(owner);
    const storageKey = `cindy.fork-request.v1:${JSON.stringify([owner.accountKey, captured.storageScope, clientId])}`;
    active.current = captured.scope;
    captured.onBusy(clientId);
    const choose = () => {
      if (!isCurrent()) return;
      selection.current = { scope: captured.scope, clientId, draft, owner };
      pickedTarget.current = undefined;
      captured.setPickerOpen(true);
    };
    const recover = (pending: boolean, supported: boolean, failed = false) => {
      if (!isCurrent()) return;
      const targetFailure = !pending && request.current?.value.target;
      Alert.alert(t(pending ? 'session.forkRecovery.pendingTitle' : targetFailure ? 'session.forkRecovery.choose' : 'session.forkRecovery.unavailableTitle'),
        t(pending ? 'session.forkRecovery.pendingDescription' : targetFailure ? 'session.forkRecovery.handoffDescription' : 'session.forkRecovery.unavailableDescription'), [
          { text: t('session.screen.forkCancel'), style: 'cancel' },
          { text: t(pending && !failed ? 'session.forkRecovery.check' : 'session.forkRecovery.retry'),
            onPress: () => { if (isCurrent()) void run(clientId, draft, undefined, pending && !failed); } },
          { text: t(supported ? 'session.forkRecovery.choose' : 'session.forkRecovery.update'),
            onPress: supported ? choose : () => captured.onError(t('session.forkRecovery.update')) },
        ]);
    };
    try {
      let caps: { forkRequestVersion?: number; historyHandoff?: boolean } = {};
      try { caps = await captured.maker.getForkCapabilities(); }
      catch (error) {
        if (!/INVALID_PARAMS|CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY/.test(formatRemoteError(error))) throw error;
      }
      if (!isCurrent()) return;
      if (caps.forkRequestVersion !== 1) {
        if (target || checkOnly) { captured.onError(t('session.forkRecovery.update')); return; }
        try {
          const session = await captured.maker.fork(captured.sessionId, clientId);
          if (isCurrent()) captured.onComplete(session, draft);
        }
        catch { recover(false, false); }
        return;
      }
      if (!request.current || request.current.scope !== captured.scope
        || request.current.value.messageClientId !== clientId || target) {
        const saved = target ? null : await AsyncStorage.getItem(storageKey);
        if (!isCurrent()) return;
        let value: ForkRequest;
        if (saved) {
          if (saved.length > 8192) throw new Error(t('session.forkRecovery.pendingDescription'));
          value = JSON.parse(saved) as ForkRequest;
          if (value.version !== 1 || value.sourceSessionId !== captured.sessionId || value.messageClientId !== clientId || !value.requestId) {
            throw new Error(t('session.forkRecovery.pendingDescription'));
          }
        } else value = { version: 1, action: 'create', requestId: randomUUID(),
          sourceSessionId: captured.sessionId, messageClientId: clientId, ...(target ? { target } : {}) };
        await AsyncStorage.setItem(storageKey, JSON.stringify(value));
        if (!isCurrent()) return;
        request.current = { scope: captured.scope, value };
      }
      const value = { ...request.current.value, action: checkOnly ? 'status' as const : 'create' as const };
      let receipt;
      try { receipt = await captured.maker.requestFork(value); }
      catch (error) {
        if (!isCurrent()) return;
        // A transport error does not prove whether creation ran. One read can
        // find its commit; if that read is unavailable, keep the same request ID.
        try { receipt = await captured.maker.requestFork({ ...value, action: 'status' }); }
        catch { recover(true, caps.historyHandoff === true); return; }
        if (receipt.state === 'failed' || receipt.state === 'not-sent') {
          recover(false, caps.historyHandoff === true, true); return;
        }
      }
      if (!isCurrent()) return;
      if (receipt.state === 'complete' && receipt.session) {
        try {
          if (JSON.parse(await AsyncStorage.getItem(storageKey) ?? 'null')?.requestId === value.requestId) await AsyncStorage.removeItem(storageKey);
        } catch { /* The host commit is authoritative; a retained ID remains safe to query. */ }
        if (!isCurrent()) return;
        request.current = undefined;
        captured.onComplete(receipt.session, draft, receipt.outcome);
      } else recover(true, caps.historyHandoff === true, receipt.state === 'failed' || receipt.state === 'not-sent');
    } catch (error) {
      if (isCurrent()) captured.onError(formatRemoteError(error));
    } finally {
      if (active.current === captured.scope) active.current = null;
      if (isCurrent()) captured.onBusy(null);
    }
  };
  return {
    run,
    pick(target: ForkTarget): boolean {
      const pending = selection.current;
      if (!alive.current || !pending || pending.scope !== input.scope || !isMobileAuthOwnerCurrent(pending.owner)) return false;
      pickedTarget.current = target;
      input.setPickerOpen(false);
      return true;
    },
    // Native sheets must finish dismissing before an Alert is presented on iOS.
    pickerClosed() {
      const pending = selection.current;
      const target = pickedTarget.current;
      pickedTarget.current = undefined;
      if (!target || !pending || !alive.current || pending.scope !== current.current.scope || !isMobileAuthOwnerCurrent(pending.owner)) return;
      Alert.alert(t('session.forkRecovery.choose'), t('session.forkRecovery.handoffDescription'), [
        { text: t('session.screen.forkCancel'), style: 'cancel' },
        { text: t('session.forkRecovery.continue'), onPress: () => {
          if (alive.current && current.current.scope === pending.scope && isMobileAuthOwnerCurrent(pending.owner)) void run(pending.clientId, pending.draft, target);
        } },
      ]);
    },
  };
}
