import { useEffect, useRef } from 'react';

import {
  beginPromptRecommendationPrediction,
  resolvePromptRecommendationPrediction,
  type PromptRecommendationSnapshot,
} from '@/lib/promptRecommendationStore';

/** 草稿、水合、临时锁定只暂停候选；恢复可用后仍按 session + revision 去重生成。 */
export function usePromptRecommendationPrediction({
  sessionId,
  recommendation,
  canPredict,
  predict,
}: {
  sessionId: string | undefined;
  recommendation: PromptRecommendationSnapshot | undefined;
  canPredict: boolean;
  predict: (revision: number) => Promise<string | null>;
}): void {
  const predictRef = useRef(predict);
  predictRef.current = predict;

  useEffect(() => {
    if (!sessionId || !canPredict || recommendation?.phase !== 'candidate') return;
    const revision = recommendation.revision;
    const requestSeq = beginPromptRecommendationPrediction(sessionId, revision);
    if (requestSeq == null) return;
    // 切换任务或暂时输入文字不取消在途请求；结果仍落到原 session，重新打开可复用。
    void predictRef.current(revision).then(
      (prompt) => resolvePromptRecommendationPrediction(sessionId, revision, requestSeq, prompt),
      () => resolvePromptRecommendationPrediction(sessionId, revision, requestSeq, null),
    );
  }, [canPredict, recommendation?.phase, recommendation?.revision, sessionId]);
}
