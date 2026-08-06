import { describe, expect, it } from 'vitest';

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion.js';
import {
  buildChildrenByParent,
  buildPiPathMarkers,
  classifyMonitoredAgentCommandLine,
  collectDescendantPids,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  registerPiUserDataMarkers,
} from '../agent-scan.js';

describe('parsePosixProcessTable', () => {
  it('解析 pid/ppid/%cpu/rss/command,容忍空行与非法行', () => {
    const out = [
      '  101   100  12.5  20480 /usr/bin/node server.js',
      '',
      'garbage line without numbers',
      '  102   101   0.0    512 bash -c "sleep 1"',
    ].join('\n');
    const rows = parsePosixProcessTable(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pid: 101,
      ppid: 100,
      cpuPercent: 12.5,
      memoryKb: 20480,
      cpuTimeMs: null,
    });
    expect(rows[0].cmdLineLower).toBe('/usr/bin/node server.js');
    expect(rows[1].cmdLineLower).toContain('sleep 1');
  });
});

describe('parseWindowsProcessTable', () => {
  it('解析 pid|ppid|workingSet|cpuTime|cmd,命令行含管道符不截断', () => {
    const out = [
      '4321|100|104857600|1500000|C:\\bin\\claude.exe run | tee log',
      'not|a|row',
      '',
    ].join('\r\n');
    const rows = parseWindowsProcessTable(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4321,
      ppid: 100,
      memoryKb: 102400, // 100MB → KB
      cpuTimeMs: 150, // 1_500_000 * 100ns = 150ms
      cpuPercent: null,
    });
    expect(rows[0].cmdLineLower).toBe('c:\\bin\\claude.exe run | tee log');
  });

  it('有输出但全不可解析时返回空(格式漂移由上层日志暴露)', () => {
    expect(parseWindowsProcessTable('ProcessId ParentProcessId\n123 456')).toEqual([]);
  });
});

describe('classifyMonitoredAgentCommandLine', () => {
  it('识别 pi 静态品牌 marker,不影响 claude/codex 委托', () => {
    const piMarkers = buildPiPathMarkers(['cindy']);
    expect(piMarkers).toContain('appdata\\roaming\\cindy\\pi\\');
    // 品牌目录名随构建配置变化(如 CindyGlobal / 历史 xdt-maker),测试从真实
    // 品牌清单派生 probe,不写死品牌名。
    const brandDir = allUserDataDirNames(CURRENT_CINDY_REGION)[0].toLowerCase();
    expect(
      classifyMonitoredAgentCommandLine(
        `c:\\users\\u\\appdata\\roaming\\${brandDir}\\pi\\1.0\\pi.exe`,
      ),
    ).toBe('pi');
    // 外部安装的同名二进制不带产品 marker → 不认领。
    expect(classifyMonitoredAgentCommandLine('/usr/local/bin/pi serve')).toBeNull();
  });

  it('识别运行时 userData 派生的 pi marker(userData 重定向场景)', () => {
    registerPiUserDataMarkers('/custom/data-home/CindyBrand');
    expect(
      classifyMonitoredAgentCommandLine('/custom/data-home/cindybrand/pi/2.0/pi --rpc'),
    ).toBe('pi');
    // 恢复默认组,避免污染其它用例(整组替换语义)。
    registerPiUserDataMarkers('');
  });
});

describe('buildChildrenByParent / collectDescendantPids', () => {
  it('展开整棵子树且防环', () => {
    const rows = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 9 }, // 无关分支
    ].map((r) => ({ ...r, cmdLineLower: '', memoryKb: 0, cpuPercent: 0, cpuTimeMs: null }));
    const map = buildChildrenByParent(rows);
    // 人为制造环:3 → 1
    map.set(3, [1]);
    const pids = collectDescendantPids(1, map);
    expect([...pids].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
