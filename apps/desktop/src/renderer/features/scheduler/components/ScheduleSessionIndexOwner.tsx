import { useMatch } from 'react-router-dom';
import { useAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';

/** 每个任务窗口只持有一份索引；副窗口折叠侧栏时仍提供失败历史和已读状态。 */
export function ScheduleSessionIndexOwner() {
  const match = useMatch('/cc-agent/:sessionId');
  const orcaMatch = useMatch('/cc-agent/orca/:sessionId');
  const filesMatch = useMatch('/cc-agent/files/:sessionId');
  useAutomationScheduleSessionIndex(
    orcaMatch?.params.sessionId ?? match?.params.sessionId ?? filesMatch?.params.sessionId,
  );
  return null;
}
