/**
 * pi-manager CLI 层测试(轮 17 H-1:bin/pi-manager.ts 此前 0% 覆盖)。
 *
 * 测 parseArgs / splitFlag / printVersion / stripSensitiveEnv 的纯逻辑;
 * runDaemon/runBridge/selfDetach 是进程级(daemon 生命周期由集成测试覆盖)。
 *
 * 注意:
 * - 模块顶层有 void main(), import 时 process.argv 是 vitest → 走 help 分支
 *   printHelp + process.exit(0) —— 先拦 process.exit 防测试进程退出。
 * - parseArgs 的未知 flag 分支会 process.exit(2) —— 同样拦截断言。
 * - stripSensitiveEnv 直接改 process.env, 每个用例后还原。
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

// 拦 process.exit:模块 import 时的 main() 会调 exit, 测试内未知 flag 也调。
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

import {
  parseArgs,
  splitFlag,
  printVersion,
  stripSensitiveEnv,
} from '../bin/pi-manager.js';

beforeEach(() => {
  exitSpy.mockClear();
});

afterEach(() => {
  exitSpy.mockClear();
});

describe('parseArgs', () => {
  it('parses --version / -v as version command', () => {
    expect(parseArgs(['node', 'pi-manager.mjs', '--version']).command).toBe('version');
    expect(parseArgs(['node', 'pi-manager.mjs', '-v']).command).toBe('version');
  });

  it('parses --help / -h / no args as help command', () => {
    expect(parseArgs(['node', 'pi-manager.mjs', '--help']).command).toBe('help');
    expect(parseArgs(['node', 'pi-manager.mjs', '-h']).command).toBe('help');
    expect(parseArgs(['node', 'pi-manager.mjs']).command).toBe('help');
  });

  it('parses daemon with --socket / -s / --detach / --log-file / --idle-timeout', () => {
    const args = parseArgs([
      'node', 'pi-manager.mjs', 'daemon',
      '--socket', '/tmp/pi.sock', '--detach', '--log-file', '/tmp/pi.log',
      '--idle-timeout', '600',
    ]);
    expect(args.command).toBe('daemon');
    expect(args.socket).toBe('/tmp/pi.sock');
    expect(args.detach).toBe(true);
    expect(args.logFile).toBe('/tmp/pi.log');
    expect(args.idleTimeoutSeconds).toBe(600);
  });

  it('parses --socket=/path (equals form) — round 4 LOW #11', () => {
    const args = parseArgs(['node', 'pi-manager.mjs', 'daemon', '--socket=/tmp/pi.sock']);
    expect(args.command).toBe('daemon');
    expect(args.socket).toBe('/tmp/pi.sock');
  });

  it('rejects unknown flags with exit(2) — round 4 LOW #11', () => {
    parseArgs(['node', 'pi-manager.mjs', 'daemon', '--verbose']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('rejects non-numeric --idle-timeout with exit(2)', () => {
    parseArgs(['node', 'pi-manager.mjs', 'daemon', '--socket', '/x', '--idle-timeout', 'abc']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('parses bridge with --socket', () => {
    const args = parseArgs(['node', 'pi-manager.mjs', 'bridge', '-s', '/tmp/session.sock']);
    expect(args.command).toBe('bridge');
    expect(args.bridgeSock).toBe('/tmp/session.sock');
  });

  it('rejects bridge without --socket with exit(2)', () => {
    parseArgs(['node', 'pi-manager.mjs', 'bridge']);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe('splitFlag', () => {
  it('splits --key=value into [flag, value]', () => {
    expect(splitFlag('--socket=/tmp/x')).toEqual(['--socket', '/tmp/x']);
  });

  it('returns [arg, undefined] for bare flags', () => {
    expect(splitFlag('--detach')).toEqual(['--detach', undefined]);
    expect(splitFlag('daemon')).toEqual(['daemon', undefined]);
  });
});

describe('printVersion', () => {
  it('outputs valid JSON with managerVersion + protocolVersion', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printVersion();
      const out = writeSpy.mock.calls[0][0] as string;
      const parsed = JSON.parse(out);
      expect(parsed.managerVersion).toBeTruthy();
      expect(typeof parsed.protocolVersion).toBe('number');
      expect(out.endsWith('\n')).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('stripSensitiveEnv', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // 还原全部 env(测试可能删除键)
    process.env = { ...savedEnv };
  });

  it('strips credential keys by prefix (incl. round 11 LOW-5 additions)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-xxx';
    process.env.GITHUB_TOKEN = 'ghp_xxx';
    process.env.HF_TOKEN = 'hf_xxx';
    process.env.BRAVE_KEY = 'bsa_xxx';

    const stripped = stripSensitiveEnv();

    expect(stripped).toContain('ANTHROPIC_API_KEY');
    expect(stripped).toContain('GITHUB_TOKEN');
    expect(stripped).toContain('HF_TOKEN');
    expect(stripped).toContain('BRAVE_KEY');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('strips bare credential keys by exact match (round 4 MEDIUM #7)', () => {
    process.env.API_KEY = 'sk-123';
    process.env.TOKEN = 'abc';
    process.env.HOME = '/home/u'; // 不应被剥

    const stripped = stripSensitiveEnv();

    expect(stripped).toContain('API_KEY');
    expect(stripped).toContain('TOKEN');
    expect(stripped).not.toContain('HOME');
    expect(process.env.HOME).toBe('/home/u');
  });

  it('strips suffix keys (_SECRET / _TOKEN / _AUTH) — deep-review 5 L-3', () => {
    process.env.MY_SECRET = 's3cr3t';
    process.env.MY_API_TOKEN = 'tok';
    process.env.ENABLE_AUTH = 'true'; // _AUTH 后缀会误剥(已知过度保守, 断言现状)

    const stripped = stripSensitiveEnv();

    expect(stripped).toContain('MY_SECRET');
    expect(stripped).toContain('MY_API_TOKEN');
  });

  it('does not strip non-credential keys', () => {
    process.env.PATH = '/usr/bin';
    process.env.LANG = 'en_US';

    const stripped = stripSensitiveEnv();

    expect(stripped).not.toContain('PATH');
    expect(stripped).not.toContain('LANG');
  });
});
