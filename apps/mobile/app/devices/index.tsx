import { HomeUnreadProvider } from '@/session/HomeUnreadContext';
import { useAuth } from '@/auth/AuthContext';
import { MobileHome } from '@/session/HomeSurface';
import { HomeModePanes } from '@/session/HomeModePanes';
import { TeammateHomeScreen } from '@/session/TeammateHomeScreen';
import { useHomeMode } from '@/session/useHomeMode';

export default function HomeScreen() {
  const { accountGeneration } = useAuth();
  const navigation = useHomeMode();
  if (!navigation.hydrated) return null;
  return <HomeUnreadProvider key={accountGeneration}><HomeModePanes mode={navigation.mode}
    tasks={<MobileHome active={navigation.mode === 'tasks'} onModeChange={navigation.setMode} />}
    teammates={<TeammateHomeScreen active={navigation.mode === 'teammates'} />} /></HomeUnreadProvider>;
}
