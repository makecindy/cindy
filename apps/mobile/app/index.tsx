import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import HomeScreen from './devices';

export default function IndexScreen() {
  const auth = useAuth();
  // auth 恢复期间由根部常驻 splash 覆盖层顶着(见 StartupSplashOverlay),这里不再
  // 渲染独立的 splash 实例,避免与覆盖层交接时的 remount 闪帧。
  if (!auth.initialized) return null;
  // 「跳过登录」态无账号也可进主界面(产品拍板 2026-07-27),与 NavigationGate 同门。
  if (!auth.isAuthenticated && !auth.isLocalMode) return <Redirect href="/login" />;
  return <HomeScreen />;
}
