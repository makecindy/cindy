/**
 * 手机端「未起名任务标题」投影的出口清单。
 *
 * 不变量:用户能看到的每个任务标题出口都必须过 projectDraftSessionTitle,内部哨兵
 * `New Maker` 一处都不许原样渲染;而重命名输入框预填投影值后,**必须**有一条
 * 「没改就不落库」的判据同时比原始标题与投影值 —— 否则用户双击后原样确定就会把兜底
 * 文案写进 DB,哨兵被毁、自动起名永久跳过该任务(PR #1031)。
 *
 * 这些出口散在大型屏幕组件里(RN 组件在本仓没有渲染测试基座),用源码不变量钉住:
 * 定位精确、不依赖 UI 基座,后续谁改动这几行都会在这里失败。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(__dirname, '..', '..');

function read(relPath: string): string {
  return readFileSync(resolve(APP_ROOT, relPath), 'utf8');
}

const sessionScreen = read('app/sessions/[sessionId].tsx');
const homeScreen = read('app/devices/index.tsx');
const automationsScreen = read('app/automations/[deviceId].tsx');
const menuSheet = read('src/session/SessionMenuSheet.tsx');

describe('mobile 会话标题投影出口', () => {
  it('会话页标题栏过投影', () => {
    expect(sessionScreen).toContain(
      "projectDraftSessionTitle(currentSession?.title, t('session.menu.unnamedTitle'))",
    );
  });

  it('首页删除确认里的标题过投影', () => {
    expect(homeScreen).toContain(
      "projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')).trim()",
    );
  });

  it('自动化绑定会话选择器过投影', () => {
    expect(automationsScreen).toContain(
      "projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle'))",
    );
  });

  it('两个重命名入口都用投影值预填', () => {
    expect(homeScreen).toContain(
      "setRenameSessionDraft(projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle')))",
    );
    expect(menuSheet).toContain(
      "const renamePrefill = projectDraftSessionTitle(session.title, t('session.menu.unnamedTitle'));",
    );
    // 预填一旦是投影值,输入框里就不能再出现原始哨兵。
    expect(menuSheet).not.toContain("setTitleDraft(session.title ?? '')");
  });

  it('两个重命名入口的「没改就不落库」判据都覆盖投影值', () => {
    // 只比原始标题 → 兜底文案被写进 DB,哨兵被毁。
    expect(homeScreen).toContain(
      "if (title === projectDraftSessionTitle(target.title, t('session.menu.unnamedTitle'))) return;",
    );
    expect(menuSheet).toContain('if (!next || next === session.title || next === renamePrefill) {');
  });
});
