import { useAuth } from '@/auth/AuthContext';
import { MobileHome } from '@/session/HomeSurface';
import { HomeModePanes } from '@/session/HomeModePanes';
import { TeammateHomeScreen } from '@/session/TeammateHomeScreen';
import { useHomeMode } from '@/session/useHomeMode';

export default function HomeScreen() {
  const { accountGeneration } = useAuth();
  const navigation = useHomeMode();
  if (!navigation.hydrated) return null;
  return <HomeModePanes key={accountGeneration} mode={navigation.mode}
    tasks={<MobileHome active={navigation.mode === 'tasks'} onModeChange={navigation.setMode} />}
    teammates={<TeammateHomeScreen active={navigation.mode === 'teammates'} />} />;
}
