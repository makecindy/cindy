export function createProviderConfigMutations(deps: {
 beginRouteMutation(providerId: string): (() => void) & {commit?: () => void};
}) {
  const providerConfigMutationCounts = new Map<string, number>();
  const providerConfigMutationTails = new Map<string, Promise<void>>();
  const beginProviderConfigMutation = (providerId: string): void => {
    providerConfigMutationCounts.set(
      providerId,
      (providerConfigMutationCounts.get(providerId) ?? 0) + 1,
    );
  };
  const finishProviderConfigMutation = (providerId: string): void => {
    const remaining = (providerConfigMutationCounts.get(providerId) ?? 1) - 1;
    if (remaining <= 0) providerConfigMutationCounts.delete(providerId);
    else providerConfigMutationCounts.set(providerId, remaining);
  };
  const withProviderConfigMutation = async <T>(
    providerId: string,
    operation: (commitRouteMutation: () => void) => Promise<T>,
  ): Promise<T> => {
    const finishRouteMutation = deps.beginRouteMutation(providerId);
    const commitRouteMutation = (): void => finishRouteMutation.commit?.();
    const previous = providerConfigMutationTails.get(providerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    providerConfigMutationTails.set(providerId, tail);
    // 排队时即计入 mutation，避免等待前序写入期间启动新的 OAuth flow。
    beginProviderConfigMutation(providerId);
    try {
      await previous.catch(() => undefined);
      return await operation(commitRouteMutation);
    } finally {
      release();
      if (providerConfigMutationTails.get(providerId) === tail) {
        providerConfigMutationTails.delete(providerId);
      }
      finishProviderConfigMutation(providerId);
      finishRouteMutation();
    }
  };
return {withProviderConfigMutation, providerConfigMutationCounts};
}
