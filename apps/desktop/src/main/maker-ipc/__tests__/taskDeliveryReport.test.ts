/*
 * 测试价值
 * - 生产入口与可观察结果:readTaskDeliveryNote(发给执行模型的交付说明)与 reportTaskDelivery(report_task_delivery 工具)。
 * - Bug／规则依据:#7253 / #8026 —— 只有记下了原始对话的任务才要交付回报;已退役的运行实例不能借用替代者的当前一轮。
 * - 现有覆盖缺口:随 V1 跟进观察层删除从 bot-autonomy/hub.test.ts 移来;跟进者条件已去掉,只按是否记下原始对话判断。
 * - 最小失败输入:没有原始对话的任务;实例 id 不符的回报;宿主拒绝记录的回报。
 * - tier:unit(宿主回调注入,无 Electron、无数据库)。
 */
import { afterEach, expect, it, vi } from 'vitest';

import { configureTaskDeliveryReport, readTaskDeliveryNote, reportTaskDelivery } from '../taskDeliveryReport.js';

afterEach(() => configureTaskDeliveryReport(null));

it('adds the delivery note only to a task with a recorded origin', async () => {
  expect(await readTaskDeliveryNote('task')).toBeNull();
  const wantsReport = vi.fn(async (id: string) => id === 'with-origin');
  configureTaskDeliveryReport({ readSessionExecution: () => null, wantsReport, report: () => false });
  expect(await readTaskDeliveryNote('with-origin')).toContain('report_task_delivery');
  expect(await readTaskDeliveryNote('unrelated')).toBeNull();
  expect(wantsReport).toHaveBeenCalledWith('with-origin');
});

// A retired runtime cannot borrow a replacement's current turn.
it('records a report only for the live execution of the calling instance', () => {
  const report = vi.fn(() => true);
  configureTaskDeliveryReport({ readSessionExecution: () => ({ instanceId: 'live', generation: 2 }), wantsReport: async () => true, report });
  expect(reportTaskDelivery('task', true, 'retired')).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
  expect(report).not.toHaveBeenCalled();
  expect(reportTaskDelivery('task', true, 'live')).toEqual({ ok: true });
  expect(report).toHaveBeenCalledWith('task', { instanceId: 'live', generation: 2 }, true);
  report.mockReturnValueOnce(false);
  expect(reportTaskDelivery('task', false)).toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
});
