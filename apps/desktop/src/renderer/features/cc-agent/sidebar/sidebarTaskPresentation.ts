import * as React from 'react';
import './sidebarTaskPresentation.css';
import { useTranslation } from 'react-i18next';
import { isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useSidebarPresentationSnapshot } from '@/features/bots/botFollowScopes';
import { sessionsStore } from '@/lib/sessionsStore';
import { createSidebarTaskPresentation } from './sidebarTaskPresentationView';

export const sidebarTaskPresentation = createSidebarTaskPresentation(React, {
  useSnapshot: useSidebarPresentationSnapshot,
  isOwnerCurrent: isDataOwnerGenerationCurrent,
  useLanguage: () => {
    const { i18n } = useTranslation();
    return i18n.resolvedLanguage ?? i18n.language;
  },
  readSession: (id) => window.electronAPI.localDb.sessions.get(id),
  subscribeSession: (id, listener) =>
    sessionsStore.subscribePatches((sessionId, patch, row) => {
      if (sessionId === id) listener(patch, row);
    }),
});
