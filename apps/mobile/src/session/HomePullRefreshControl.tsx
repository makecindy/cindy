import { useCallback, useState } from 'react';
import { RefreshControl, type RefreshControlProps } from 'react-native';

type Props = Omit<RefreshControlProps, 'refreshing' | 'onRefresh'> & { onRefresh(): Promise<void> };

export function HomePullRefreshControl({ onRefresh, ...props }: Props) {
  const [pending, setPending] = useState<Promise<void> | null>(null);
  const pull = useCallback(() => {
    const request = onRefresh();
    setPending(request);
    const finish = () => setPending(current => current === request ? null : current);
    void request.then(finish, finish);
  }, [onRefresh]);
  return <RefreshControl {...props} refreshing={pending !== null} onRefresh={pull} />;
}
