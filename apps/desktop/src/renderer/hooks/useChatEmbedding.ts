/** React subscription and mutation helpers for the owner-scoped chat embedding mirror. */

import { useCallback, useEffect, useState } from 'react';

import {
  beginChatEmbeddingMutation,
  completeChatEmbeddingMutation,
  getChatEmbeddingSnapshot,
  refreshChatEmbeddingFromMain,
  rollbackChatEmbeddingMutation,
  subscribeChatEmbeddingSnapshot,
  type ChatEmbeddingMutationToken,
  type ChatEmbeddingSnapshot,
} from '@/lib/chatEmbeddingStore';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';

export function useChatEmbedding(): ChatEmbeddingSnapshot & {
  beginMutation: (optimisticEnabled?: boolean) => ChatEmbeddingMutationToken;
  completeMutation: (token: ChatEmbeddingMutationToken, settings: ChatEmbeddingSnapshot) => boolean;
  rollbackMutation: (token: ChatEmbeddingMutationToken) => boolean;
} {
  const [snapshot, setSnapshot] = useState<ChatEmbeddingSnapshot>(getChatEmbeddingSnapshot);

  useEffect(() => {
    const unsubscribe = subscribeChatEmbeddingSnapshot(setSnapshot);
    const unsubscribeProviders = window.electronAPI.maker.onProvidersChanged(() => {
      void refreshChatEmbeddingFromMain();
    });
    const unsubscribeSettings = window.electronAPI.maker.onChatEmbeddingChanged((stamp) => {
      if (isDataOwnerPushStampCurrent(stamp)) void refreshChatEmbeddingFromMain();
    });
    void refreshChatEmbeddingFromMain();
    return () => {
      unsubscribe();
      unsubscribeProviders();
      unsubscribeSettings();
    };
  }, []);

  const beginMutation = useCallback(
    (optimisticEnabled?: boolean) => beginChatEmbeddingMutation(optimisticEnabled),
    [],
  );
  const completeMutation = useCallback(
    (token: ChatEmbeddingMutationToken, settings: ChatEmbeddingSnapshot) =>
      completeChatEmbeddingMutation(token, settings),
    [],
  );
  const rollbackMutation = useCallback(
    (token: ChatEmbeddingMutationToken) => rollbackChatEmbeddingMutation(token),
    [],
  );

  return {
    ...snapshot,
    beginMutation,
    completeMutation,
    rollbackMutation,
  };
}
