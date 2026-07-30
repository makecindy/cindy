export interface PersistAndHydrateSessionProviderInput {
  sessionId: string;
  providerId: string | null | undefined;
  updateProviderId: (sessionId: string, providerId: string | null) => Promise<void>;
  readProviderId: (sessionId: string) => Promise<string | null | undefined>;
  hydrateSessionProvider: (sessionId: string, providerId: string | null) => void;
}

/**
 * create-session 后同步 provider route：显式 null 要落库覆盖旧来源，undefined 才表示不改库。
 */
export async function persistAndHydrateSessionProvider(
  input: PersistAndHydrateSessionProviderInput,
): Promise<void> {
  const createProviderId =
    typeof input.providerId === 'string' && input.providerId.trim()
      ? input.providerId.trim()
      : null;
  if (input.providerId !== undefined) {
    await input.updateProviderId(input.sessionId, createProviderId);
  }
  const persistedProviderId = await input.readProviderId(input.sessionId);
  // undefined 表示 DB 没有对应行，不能把它解释为“显式清空”并覆盖运行时选择。
  if (persistedProviderId !== undefined) {
    input.hydrateSessionProvider(input.sessionId, persistedProviderId);
  }
}
