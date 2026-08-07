import { describe, expect, it } from 'vitest';

import { allUserDataDirNames } from '@cindy/maker-shared/brand-identity';

import { CURRENT_CINDY_REGION } from '../../../shared/brandRegion.js';
import {
  buildChildrenByParent,
  buildPiPathMarkers,
  buildPosixProcessScanEnv,
  classifyMonitoredAgentCommandLine,
  collectDescendantPids,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  registerPiUserDataMarkers,
} from '../agent-scan.js';

describe('buildPosixProcessScanEnv', () => {
  it('固定英文输出与 UTC，消除 lstart 的 locale / DST 歧义', () => {
    expect(buildPosixProcessScanEnv({ LANG: 'zh_CN.UTF-8', TZ: 'Asia/Shanghai' })).toEqual({
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'C',
      TZ: 'UTC0',
    });
  });
});

describe('parsePosixProcessTable', () => {
  it('解析 pid/ppid/stat/%cpu/rss/lstart/command,容忍空行与非法行', () => {
    const out = [
      '  101   100  S+  12.5  20480 Wed Aug  6 12:34:56 2026 /usr/bin/node server.js',
      '',
      'garbage line without numbers',
      '  102   101  T    0.0    512 Wed Aug  6 12:35:01 2026 bash -c "sleep 1"',
    ].join('\n');
    const rows = parsePosixProcessTable(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      pid: 101,
      ppid: 100,
      state: 'S+',
      cpuPercent: 12.5,
      memoryKb: 20480,
      cpuTimeMs: null,
      startIdentity: 'Wed Aug 6 12:34:56 2026',
    });
    expect(rows[0].cmdLineLower).toBe('/usr/bin/node server.js');
    expect(rows[1].cmdLineLower).toContain('sleep 1');
    expect(rows[1].state).toBe('T');
  });
});

describe('parseWindowsProcessTable', () => {
  it('解析 pid|ppid|workingSet|cpuTime|creationTicks|cmd,命令行含管道符不截断', () => {
    const out = [
      '4321|100|104857600|1500000|638901092960000000|C:\\bin\\claude.exe run | tee log',
      'not|a|row',
      '',
    ].join('\r\n');
    const rows = parseWindowsProcessTable(out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pid: 4321,
      ppid: 100,
      state: null,
      memoryKb: 102400, // 100MB → KB
      cpuTimeMs: 150, // 1_500_000 * 100ns = 150ms
      cpuPercent: null,
      startIdentity: '638901092960000000',
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

  it('识别 dev/sandbox 的 apps/pi-bin 二进制路径', () => {
    expect(
      classifyMonitoredAgentCommandLine(
        'd:\\projects\\cindy\\apps\\pi-bin\\win32-x64\\pi.exe --rpc',
      ),
    ).toBe('pi');
    expect(
      classifyMonitoredAgentCommandLine('/repo/apps/pi-bin/darwin-arm64/pi --rpc'),
    ).toBe('pi');
  });

  it('识别运行时 userData 派生的 pi marker(userData 重定向场景)', () => {
    registerPiUserDataMarkers('/custom/data-home/CindyBrand');
    expect(
      classifyMonitoredAgentCommandLine('/custom/data-home/cindybrand/pi/2.0/pi --rpc'),
    ).toBe('pi');
    // 空路径显式清空，不能退化成会命中所有 `/pi/` 路径的宽泛 marker。
    registerPiUserDataMarkers('');
    expect(classifyMonitoredAgentCommandLine('/opt/pi/2.0/pi --rpc')).toBeNull();
  });
});

describe('buildChildrenByParent / collectDescendantPids', () => {
  it('展开整棵子树且防环', () => {
    const rows = [
      { pid: 1, ppid: 0 },
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 9 }, // 无关分支
    ].map((r) => ({
      ...r,
      state: null,
      cmdLineLower: '',
      memoryKb: 0,
      cpuPercent: 0,
      cpuTimeMs: null,
      startIdentity: null,
    }));
    const map = buildChildrenByParent(rows);
    // 人为制造环:3 → 1
    map.set(3, [1]);
    const pids = collectDescendantPids(1, map);
    expect([...pids].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
