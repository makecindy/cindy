/**
 * maskPath 的方向锁：日志里的路径只允许留下末两段，绝不回传完整绝对路径。
 *
 * 规则依据：PR #6105 review（2026-11-11）——POSIX 目录名可合法包含字面反斜杠，
 * 旧实现「出现 `\` 就按 Windows 分隔符切」会把 `/home/alice/proj\private/
 * resources/icon.png` 切成 2 段、经「已很短」分支整条原样返回；该路径随后可随
 * 放行的 `linux-tray` scope 上传，脱敏只抹用户名段、目录结构其余部分仍外泄。
 * 现有覆盖缺口：maskPath 此前没有任何直接单测。最小失败输入即上述反斜杠路径。
 * 纯函数、无 I/O，unit tier。standalone vitest duration: <0.1s。
 */
import { describe, expect, it } from 'vitest';

import { maskPath } from '../logger';

describe('maskPath', () => {
  it('keeps only the trailing 2 segments of POSIX and Windows paths', () => {
    expect(maskPath('/home/sam/projects/cindy/apps/desktop/resources/icon.png')).toBe(
      '.../resources/icon.png',
    );
    expect(maskPath('/home/sam/checkout/resources/icon.png')).toBe('.../resources/icon.png');
    expect(maskPath('C:\\Users\\admin\\AppData\\Roaming\\cindy')).toBe(
      '...\\Roaming\\cindy',
    );
  });

  it('returns already-short paths as-is', () => {
    expect(maskPath('/tmp')).toBe('/tmp');
    expect(maskPath('C:\\cindy')).toBe('C:\\cindy');
  });

  it('maps empty input to <null>', () => {
    expect(maskPath(null)).toBe('<null>');
    expect(maskPath(undefined)).toBe('<null>');
    expect(maskPath('')).toBe('<null>');
  });

  it('⚠️ POSIX 路径含字面反斜杠的目录名时不得整条返回（2026-11-11 review）', () => {
    // 反斜杠在 POSIX 文件名里合法；旧的「见 `\` 即按 Windows 切」会让此路径只剩
    // 2 段、经 already-short 分支把完整绝对路径（含用户名与目录结构）交给调用方。
    expect(maskPath('/home/alice/proj\\private/resources/icon.png')).toBe(
      '.../resources/icon.png',
    );
    expect(maskPath('/home/alice/proj\\private/resources/icon.png')).not.toContain('alice');
  });

  it('⚠️ 反斜杠多于正斜杠时仍按反斜杠结构遮蔽（Windows 主路径不受影响）', () => {
    expect(maskPath('C:\\Users\\alice\\a\\b\\c\\icon.png')).toBe('...\\c\\icon.png');
  });
});
