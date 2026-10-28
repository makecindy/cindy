import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import HomeScreen from './devices';

export default function IndexScreen() {
  const auth = useAuth();
  // auth 恢复期间由根部常驻 splash 覆盖层顶着(见 StartupSplashOverlay),这里不再
  // 渲染独立的 splash 实例,避免与覆盖层交接时的 remount 闪帧。
  if (!auth.initialized) return null;
  if (!auth.isAuthenticated) return <Redirect href="/login" />;
  return <HomeScreen />;
}
