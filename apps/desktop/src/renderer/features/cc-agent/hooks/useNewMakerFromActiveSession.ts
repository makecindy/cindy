import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';

import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { getSessionFor } from '@/lib/makerTransport';
import type { Session } from '@/lib/ccAgent.types';
import type { DialogueDeviceTarget } from '../lib/dialogueCreateTarget';
import {
  makeDialogueNewMakerRouteState,
  makeSessionTargetRouteState,
  type NewMakerRouteState,
} from '../lib/newMakerRouteState';
import { buildNewMakerSessionSeed } from '../lib/newMakerSessionSeed';

function findActiveSession(
  sessionId: string | undefined,
  localSessions: readonly Session[],
  remoteSessions: readonly Session[],
): Session | undefined {
  if (!sessionId) return undefined;
  return (
    remoteSessions.find((session) => session.id === sessionId)
    ?? localSessions.find((session) => session.id === sessionId)
  );
}

export function makeSeededDialogueRouteState(
  activeSession: Session | undefined,
  target: DialogueDeviceTarget | null,
): NewMakerRouteState {
  if (!activeSession) return makeDialogueNewMakerRouteState(target);
  const activeDeviceId = activeSession.deviceLinkDeviceId ?? null;
  const targetDeviceId = target?.deviceId ?? null;
  if (activeDeviceId !== targetDeviceId) return makeDialogueNewMakerRouteState(target);
  return makeSessionTargetRouteState(
    buildNewMakerSessionSeed(activeSession, { mode: 'dialogue', dialogueTarget: target }),
    'dialogue',
  );
}

export function useNewMakerFromActiveSession() {
  const navigate = useNavigate();
  const sessionMatch = useMatch('/cc-agent/:sessionId');
  const orcaSessionMatch = useMatch('/cc-agent/orca/:sessionId');
  const filesSessionMatch = useMatch('/cc-agent/files/:sessionId');
  const activeSessionId =
    orcaSessionMatch?.params.sessionId
    ?? filesSessionMatch?.params.sessionId
    ?? sessionMatch?.params.sessionId;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const fallbackNavigationEpochRef = useRef(0);
  useEffect(() => () => {
    fallbackNavigationEpochRef.current += 1;
  }, []);
  const { sessions: localSessions } = useCCSessions({ includeArchived: 'all' });
  const remoteSessions = useRemoteProjectSessions();
  const activeSession = useMemo(
    () => findActiveSession(activeSessionId, localSessions, remoteSessions),
    [activeSessionId, localSessions, remoteSessions],
  );

  const startGeneric = useCallback(() => {
    const navigateGeneric = () => {
      navigate('/cc-agent/new', { state: { workspacePrompt: 'generic' } });
    };
    if (activeSession) {
      navigate('/cc-agent/new', {
        state: makeSessionTargetRouteState(
          buildNewMakerSessionSeed(activeSession, { mode: 'generic' }),
          'generic',
        ),
      });
      return;
    }
    if (!activeSessionId) {
      navigateGeneric();
      return;
    }
    const sourceSessionId = activeSessionId;
    const fallbackNavigationEpoch = ++fallbackNavigationEpochRef.current;
    void getSessionFor(sourceSessionId)
      .then((session) => {
        if (
          fallbackNavigationEpochRef.current !== fallbackNavigationEpoch
          || activeSessionIdRef.current !== sourceSessionId
        ) return;
        navigate('/cc-agent/new', {
          state: makeSessionTargetRouteState(
            buildNewMakerSessionSeed(session, { mode: 'generic' }),
            'generic',
          ),
        });
      })
      .catch(() => {
        if (
          fallbackNavigationEpochRef.current !== fallbackNavigationEpoch
          || activeSessionIdRef.current !== sourceSessionId
        ) return;
        navigateGeneric();
      });
  }, [activeSession, activeSessionId, navigate]);

  return { activeSession, startGeneric };
}
