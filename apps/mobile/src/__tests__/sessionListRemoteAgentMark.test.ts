/**
 * 任务列表里「Agent 在另一台电脑运行」的标识(2026-10-09 用户裁决:手机任务列表与桌面侧栏同一个
 * 波纹标识)。被控电脑上的任务用的是第三台电脑的远程供应商时,行首 Agent 图标右上角加与模型胶囊
 * 同款的单波纹 + 点。
 *
 * 源码契约测试:Node Vitest 环境加载不了 React Native 组件(同 mobileProviderLogo.test.ts)。
 * 空白统一折叠,格式化换行不影响断言。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { sessionAgentRunsOnOtherComputer } from '@/session/sessionAgentSwitch';

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('任务列表行首的 Agent 图标', () => {
  it('Agent 在另一台电脑时才带远程标识', () => {
    const visuals = readSource('src/session/HomeListVisuals.tsx');
    expect(visuals).toContain('remote={sessionAgentRunsOnOtherComputer(item.session)}');
    // 判定只认被控电脑投影的当前位置:null / 缺省(含旧被控端)= Agent 就在被控电脑。
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: 'device-c' })).toBe(true);
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: null })).toBe(false);
    expect(sessionAgentRunsOnOtherComputer({})).toBe(false);
  });

  it('与模型胶囊同一个波纹,图标本身不缩放、不移位', () => {
    const icon = readSource('src/components/MobileVendorIcon.tsx');
    expect(icon).toContain("import { RemoteSourceMark } from '@/session/RemoteSourceMark';");
    expect(icon).toContain(
      '<RemoteSourceMark color={color} inset={{ x: (1 - anchor.x) * size, y: anchor.y * size }} size={size} > {mark} </RemoteSourceMark>',
    );
    // 不带标识时与改动前同一棵树。
    expect(icon).toContain(') : ( mark )}');
    expect(icon).not.toContain('scale(');
  });

  it('波纹贴字形右上角,位置与桌面 VendorIcon 同一套', () => {
    const icon = readSource('src/components/MobileVendorIcon.tsx');
    const desktop = readSource('../desktop/src/renderer/components/sidebar/VendorIcon.tsx');
    for (const anchor of ["'claude-code': { x: 0.95, y: 0.13 }", 'codex: { x: 0.9, y: 0.1 }']) {
      expect(icon).toContain(anchor);
    }
    expect(desktop).toContain('cc: { x: 0.95, y: 0.13 }');
    expect(desktop).toContain('codex: { x: 0.9, y: 0.1 }');
    // π 在手机端是描边路径,比桌面的 π 字符大,单独按路径定。
    expect(icon).toContain('pi: { x: 0.93, y: 0.19 }');
  });

  it('波纹跟随图标取色,随运行中呼吸一起变化', () => {
    const icon = readSource('src/components/MobileVendorIcon.tsx');
    // 波纹在带 opacity 的 Animated.View 里面,与字形共用同一个 color。
    const animated = icon.indexOf('<Animated.View');
    const remote = icon.indexOf('<RemoteSourceMark color={color}');
    expect(animated).toBeGreaterThan(0);
    expect(remote).toBeGreaterThan(animated);
    expect(icon.indexOf('</Animated.View>')).toBeGreaterThan(remote);
  });
});
