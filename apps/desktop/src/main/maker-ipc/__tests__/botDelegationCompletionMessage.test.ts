import { describe, expect, it } from 'vitest';

import {
  buildDelegationCompletionMessage,
  COMPLETION_ARTIFACTS_WIRE_LIMIT,
  COMPLETION_RESULT_WIRE_CHARS,
} from '../botDelegationCompletionMessage';

describe('buildDelegationCompletionMessage', () => {
  it('keeps the receipt header, task id, status and a short result intact', () => {
    const text = buildDelegationCompletionMessage({
      id: 'd-1',
      objective: '整理周报',
      status: 'completed',
      resultSummary: '已写好 report.md',
      artifacts: [{ absolutePath: '/tmp/report.md' }],
    });
    expect(text.startsWith('[任务回执] 后台任务已完成。task_id: d-1')).toBe(true);
    expect(text).toContain('目标事项: 整理周报');
    expect(text).toContain('结果:\n已写好 report.md');
    expect(text).toContain('交出的文件(1):\n- /tmp/report.md');
    expect(text).toContain('message_session_task');
  });

  it('bounds a long result so the hidden receipt does not grow the model context unbounded', () => {
    const long = 'x'.repeat(12_000);
    const text = buildDelegationCompletionMessage({ id: 'd-2', objective: 'o', status: 'completed', resultSummary: long });
    expect(text).toContain('x'.repeat(COMPLETION_RESULT_WIRE_CHARS));
    expect(text).not.toContain('x'.repeat(COMPLETION_RESULT_WIRE_CHARS + 1));
    expect(text).toContain('check_session_task');
    expect(text.length).toBeLessThan(COMPLETION_RESULT_WIRE_CHARS + 600);
  });

  it('lists a bounded number of artifacts and says how many more exist', () => {
    const artifacts = Array.from({ length: COMPLETION_ARTIFACTS_WIRE_LIMIT + 5 }, (_, i) => ({ absolutePath: `/out/${i}.txt` }));
    const text = buildDelegationCompletionMessage({ id: 'd-3', objective: 'o', status: 'completed', artifacts });
    expect(text).toContain(`交出的文件(${artifacts.length}):`);
    expect(text).toContain(`/out/${COMPLETION_ARTIFACTS_WIRE_LIMIT - 1}.txt`);
    expect(text).not.toContain(`/out/${COMPLETION_ARTIFACTS_WIRE_LIMIT}.txt`);
    expect(text).toContain('另有 5 个');
  });

  it('maps timeouts and failures to their status lines and clips the error', () => {
    expect(buildDelegationCompletionMessage({ id: 'd', objective: 'o', status: 'failed', lastError: 'TIMEOUT: 30m' }))
      .toContain('后台任务已超时');
    expect(buildDelegationCompletionMessage({ id: 'd', objective: 'o', status: 'timed-out' })).toContain('后台任务已超时');
    expect(buildDelegationCompletionMessage({ id: 'd', objective: 'o', status: 'cancelled' })).toContain('后台任务已取消');
    const failed = buildDelegationCompletionMessage({ id: 'd', objective: 'o', status: 'failed', lastError: 'e'.repeat(2_000) });
    expect(failed).toContain('后台任务失败了');
    expect(failed).toContain('失败原因: ' + 'e'.repeat(600) + '…(已截断)');
  });
});
