import { Navigate, useLocation, useParams } from 'react-router-dom';
import { standardSessionRoute } from '@/lib/orcaSessionIdentity';

/** Keep existing history links valid without a second task skin or read-only wrapper. */
export function BotHistorySessionView() {
  const { sessionId, deviceId } = useParams();
  const { state, search } = useLocation();
  const query = new URLSearchParams(search);
  if (deviceId) query.set('device', deviceId);
  const suffix = query.size ? `?${query}` : '';
  return <Navigate to={sessionId ? `${standardSessionRoute(sessionId)}${suffix}` : '/cc-agent'} state={state} replace />;
}
