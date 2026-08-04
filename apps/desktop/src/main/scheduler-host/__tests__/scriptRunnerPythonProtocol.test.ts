/**
 * 跨语言协议常驻验收:scheduler-host/python-client 的权威 Python 客户端
 * (protocol.py / maker_client.py / demo.py)对接真实 ScriptScheduleRunner,
 * 锁住 cindy-script/1 两端实现的兼容性(帧格式、UTF-8、stdout 纪律、
 * 能力降级)。协议或模板任何一端改动破坏兼容,这里先红。
 *
 * 机器上没有可用的 python 时整组 skip(不阻塞无 Python 的 CI 环境)。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FireContext, Schedule, ScriptCapability } from '@cindy/maker-scheduler';

import { ScriptScheduleRunner, type ScriptCapabilityBroker } from '../script-runner';

const PYTHON_CLIENT_DIR = fileURLToPath(new URL('../python-client/', import.meta.url));

function detectPython(): string | null {
  for (const cmd of ['python', 'python3']) {
    try {
      const probe = spawnSync(cmd, ['-c', 'import sys; sys.stdout.write("cindy-python-probe")'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      if (probe.status === 0 && probe.stdout === 'cindy-python-probe') return cmd;
    } catch {
      // try next candidate
    }
  }
  return null;
}

const PYTHON = detectPython();

const tmp = mkdtempSync(path.join(tmpdir(), 'cindy-script-proto-'));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function schedule(command: string): Schedule {
  return {
    id: 'py-protocol',
    name: 'py protocol',
    prompt: '',
    executionMode: 'script',
    scriptConfig: { command, capabilities: ['jira.read'], timeoutMs: 30_000 },
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    model: 'gpt-5.5',
    workspaceKind: 'project',
    workingDir: tmp,
    useWorktree: false,
    persistentSession: false,
    silentWhenIdle: false,
    notify: { desktop: false, feishu: false },
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 与真 broker 同语义的能力检查 stub:granted 之外的方法抛 CAPABILITY_DENIED。 */
function stubBroker(): ScriptCapabilityBroker {
  return {
    async call(request, granted: ReadonlySet<ScriptCapability>) {
      if (request.method === 'host.capabilities') {
        return { protocol: 'cindy-script/1', granted: [...granted].sort(), methods: [] };
      }
      const need: Record<string, ScriptCapability> = {
        'jira.get': 'jira.read',
        'jira.search_jql': 'jira.read',
        'jira.add_comment': 'jira.comment',
        'feishu.recent_chats': 'feishu.read',
        'feishu.recent_messages': 'feishu.read',
        'sessions.dispatch': 'sessions.dispatch',
      };
      const capability = need[request.method];
      if (!capability || !granted.has(capability)) {
        throw Object.assign(new Error(`capability not granted: ${capability}`), {
          code: 'CAPABILITY_DENIED',
        });
      }
      if (request.method === 'jira.get') {
        return { key: 'DING-1', fields: { summary: '登录"崩溃"了' } };
      }
      throw Object.assign(new Error('unexpected method'), { code: 'METHOD_NOT_FOUND' });
    },
  };
}

describe.skipIf(!PYTHON)('script automation Python client', () => {
  it('uses the Cindy protocol with a current host and keeps the legacy protocol with an older host', () => {
    cpSync(path.join(PYTHON_CLIENT_DIR, 'protocol.py'), path.join(tmp, 'protocol.py'));
    const {
      CINDY_SCRIPT_PROTOCOL: _cindyProtocol,
      XDT_MAKER_SCRIPT_PROTOCOL: _legacyProtocol,
      ...baseEnv
    } = process.env;
    const startFrame = `${JSON.stringify({
      protocol: 'xdt-maker-script/1',
      type: 'start',
      context: {},
    })}\n`;
    const runClient = (env: NodeJS.ProcessEnv): Record<string, unknown> => {
      const probe = spawnSync(
        PYTHON!,
        ['-c', 'from protocol import DuplexClient\nDuplexClient().emit_complete("ok")'],
        {
          cwd: tmp,
          env: { ...baseEnv, ...env, PYTHONUTF8: '1' },
          input: startFrame,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10_000,
        },
      );
      expect(probe.status, probe.stderr).toBe(0);
      return JSON.parse(probe.stdout.trim()) as Record<string, unknown>;
    };

    expect(runClient({
      CINDY_SCRIPT_PROTOCOL: '1',
      XDT_MAKER_SCRIPT_PROTOCOL: '1',
    }).protocol).toBe('cindy-script/1');
    expect(runClient({ XDT_MAKER_SCRIPT_PROTOCOL: '1' }).protocol).toBe('xdt-maker-script/1');
  });

  it('demo.py completes a full run: granted capability succeeds, denied one degrades', async () => {
    for (const file of ['protocol.py', 'maker_client.py', 'demo.py']) {
      cpSync(path.join(PYTHON_CLIENT_DIR, file), path.join(tmp, file));
    }
    const logInfo = vi.fn();
    const runner = new ScriptScheduleRunner({
      broker: stubBroker(),
      logger: { info: logInfo, warn: vi.fn(), error: vi.fn() },
    });
    const ctx: FireContext = { runId: 'run-1', firedAt: Date.now(), signal: new AbortController().signal };
    const result = await runner.fire(schedule(`${PYTHON} demo.py`), ctx);

    // jira.read 已授予且响应含中文 + 转义引号(锁 UTF-8 编码链路)
    expect(result.resultText).toContain('jira ok');
    expect(result.resultText).toContain('登录"崩溃"了');
    // feishu.read 未授予:demo 经 host.capabilities 自省后优雅降级而不是整轮失败
    expect(result.resultText).toContain('feishu skipped (not granted)');
    // demo 的 stderr 诊断被宿主截留进日志
    const completedLog = logInfo.mock.calls.find((c) => String(c[0]).includes('script completed'));
    expect(String((completedLog?.[1] as { stderr?: string })?.stderr ?? '')).toContain('run=run-1');
  }, 30_000);

  it('stray stdout noise (script print + child process) never corrupts the protocol channel', async () => {
    for (const file of ['protocol.py', 'maker_client.py']) {
      cpSync(path.join(PYTHON_CLIENT_DIR, file), path.join(tmp, file));
    }
    writeFileSync(
      path.join(tmp, 'noisy.py'),
      [
        'import subprocess',
        'import sys',
        'import maker_client',
        'print("stray before rpc")',
        'subprocess.run([sys.executable, "-c", "print(\'child noise\')"], check=True)',
        'issue = maker_client.jira_issue_get("DING-1")',
        'print("stray after rpc")',
        'maker_client.emit_complete("ok=" + issue["key"])',
        '',
      ].join('\n'),
      'utf8',
    );
    const logInfo = vi.fn();
    const runner = new ScriptScheduleRunner({
      broker: stubBroker(),
      logger: { info: logInfo, warn: vi.fn(), error: vi.fn() },
    });
    const ctx: FireContext = { runId: 'run-2', firedAt: Date.now(), signal: new AbortController().signal };
    const result = await runner.fire(schedule(`${PYTHON} noisy.py`), ctx);

    expect(result.resultText).toBe('ok=DING-1');
    const completedLog = logInfo.mock.calls.find((c) => String(c[0]).includes('script completed'));
    const stderrCapture = String((completedLog?.[1] as { stderr?: string })?.stderr ?? '');
    expect(stderrCapture).toContain('stray before rpc');
    expect(stderrCapture).toContain('child noise');
    expect(stderrCapture).toContain('stray after rpc');
  }, 30_000);
});
