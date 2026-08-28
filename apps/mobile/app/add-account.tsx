import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/AuthContext';
import { LoginScreen } from './(auth)/login';

export default function AddAccountScreen() {
  const auth = useAuth();
  const router = useRouter();
  const flowFinishedRef = useRef(false);
  const closeStartedRef = useRef(false);

  useEffect(() => {
    if (auth.loginState?.step !== 'completed') return;
    flowFinishedRef.current = true;
    router.replace('/devices');
  }, [auth.loginState?.step, router]);

  useEffect(
    () => () => {
      // Android 系统返回键可以直接移除路由。取消动作必须从卸载路径兜底，
      // 让验证码校验、账号选择等迟到结果在提交前失效。
      if (flowFinishedRef.current || closeStartedRef.current) return;
      void auth.cancelAddAccount();
    },
    [auth.cancelAddAccount],
  );

  return (
    <LoginScreen
      additionalAccount
      onClose={() => {
        closeStartedRef.current = true;
        void auth.cancelAddAccount().finally(() => router.replace('/devices'));
      }}
    />
  );
}
