import { Navigate, useLocation, useParams } from 'react-router-dom';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';

/** Keep existing history links valid without a second task skin or read-only wrapper. */
export function BotHistorySessionView() {
  const { sessionId, deviceId } = useParams();
  const { state } = useLocation();
  return <Navigate to={sessionId ? standardSessionRoute(sessionId, deviceId) : '/cc-agent'} state={state} replace />;
}
