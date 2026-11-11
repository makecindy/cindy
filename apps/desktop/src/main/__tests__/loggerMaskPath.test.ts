/**
 * maskPath 的方向锁：日志里的路径只允许留下末两段，绝不回传完整绝对路径。
 *
 * 规则依据：PR #6105 review（2026-11-11）——POSIX 目录名可合法包含字面反斜杠，
 * 旧实现「出现 `\` 就按 Windows 分隔符切」会把 `/home/alice/proj\private/
 * resources/icon.png` 切成 2 段、经「已很短」分支整条原样返回；第二轮 review 又证明
 * 「按分段数选分隔符」同样可被构造翻转（单个目录名含多于正斜杠段数的反斜杠即翻回
 * 按反斜杠切，把横跨多个真实目录名的片段当「末两段」放出去）。现改为按宿主平台
 * 语义切分：POSIX 上反斜杠永远是普通文件名字符，Windows 上 `/` 与 `\` 都是分隔符。
 * 现有覆盖缺口：maskPath 此前没有任何直接单测。最小失败输入即下列反斜杠路径。
 * 纯函数、无 I/O，unit tier。standalone vitest duration: <0.1s。
 */
import { describe, expect, it } from 'vitest';

import { maskPath } from '../logger';

describe('maskPath', () => {
  it('keeps only the trailing 2 segments of POSIX paths (host semantics)', () => {
    expect(maskPath('/home/sam/projects/cindy/apps/desktop/resources/icon.png')).toBe(
      '.../resources/icon.png',
    );
    expect(maskPath('/home/sam/checkout/resources/icon.png')).toBe('.../resources/icon.png');
  });

  it('keeps only the trailing 2 segments of Windows paths (both separators)', () => {
    expect(maskPath('C:\\Users\\admin\\AppData\\Roaming\\cindy', 'win32')).toBe(
      '...\\Roaming\\cindy',
    );
    // Windows APIs accept forward slashes too.
    expect(maskPath('C:/Users/admin/AppData/Roaming/cindy', 'win32')).toBe(
      '...\\Roaming\\cindy',
    );
  });

  it('returns already-short paths as-is', () => {
    expect(maskPath('/tmp')).toBe('/tmp');
    expect(maskPath('C:\\cindy', 'win32')).toBe('C:\\cindy');
  });

  it('maps empty input to <null>', () => {
    expect(maskPath(null)).toBe('<null>');
    expect(maskPath(undefined)).toBe('<null>');
    expect(maskPath('')).toBe('<null>');
  });

  it('⚠️ POSIX 路径含字面反斜杠的目录名时不得整条返回（2026-11-11 review 第一轮）', () => {
    // 反斜杠在 POSIX 文件名里合法；旧的「见 `\` 即按 Windows 切」会让此路径只剩
    // 2 段、经 already-short 分支把完整绝对路径（含用户名与目录结构）交给调用方。
    expect(maskPath('/home/alice/proj\\private/resources/icon.png')).toBe(
      '.../resources/icon.png',
    );
    expect(maskPath('/home/alice/proj\\private/resources/icon.png')).not.toContain('alice');
  });

  it('⚠️ 目录名内反斜杠再多也按 POSIX 语义遮蔽，不翻转到反斜杠切分（review 第二轮）', () => {
    // 上一版「按分段数选分隔符」在此输入上翻转：6 个反斜杠段 > 5 个正斜杠段，
    // 返回 ...\client-four\client-five/resources/icon.png，泄漏目录名片段。
    // 宿主语义下反斜杠只是目录名字符，整个目录随前缀一起被丢弃。
    const adversarial =
      '/home/alice/a\\client-one\\client-two\\client-three\\client-four\\client-five/resources/icon.png';
    expect(maskPath(adversarial)).toBe('.../resources/icon.png');
    expect(maskPath(adversarial)).not.toContain('client-one');
    expect(maskPath(adversarial)).not.toContain('client-five');
    expect(maskPath(adversarial)).not.toContain('alice');
  });
});
