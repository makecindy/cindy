import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLinuxUpdateScript,
  shellSingleQuote,
  DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS,
  type LinuxUpdateScriptParams,
} from '../updateScriptLinux';

const STAGED_SHA = 'a'.repeat(64);

const STAGED_SIZE = 166_000_000;

function makeParams(overrides: Partial<LinuxUpdateScriptParams> = {}): LinuxUpdateScriptParams {
  return {
    pid: 12345,
    debPath: '/tmp/cindy-0.0.2-amd64.deb',
    sha256: STAGED_SHA,
    sizeBytes: STAGED_SIZE,
    exePath: '/usr/lib/cindy/Cindy',
    lockFilePath: '/tmp/cindy-update.lock',
    logPath: '/tmp/cindy-update.log',
    ...overrides,
  };
}

describe('shellSingleQuote', () => {
  it('wraps paths in single quotes and escapes embedded quotes', () => {
    expect(shellSingleQuote(`/tmp/cindy's.deb`)).toBe(`'/tmp/cindy'\\''s.deb'`);
    expect(shellSingleQuote('/usr/lib/cindy/Cindy')).toBe(`'/usr/lib/cindy/Cindy'`);
  });
});

describe('buildLinuxUpdateScript structure', () => {
  const script = buildLinuxUpdateScript(makeParams());

  it('installs the staged .deb through one pkexec bash shell', () => {
    expect(script).toContain('PKEXEC=/usr/bin/pkexec');
    expect(script).toContain('ELEVATED=\'set -eu');
    expect(script).toContain('"$PKEXEC" /bin/bash -c "$ELEVATED"');
    expect(script).toContain('apt-get install --yes --allow-downgrades');
    expect(script).toContain('dpkg --install');
    expect(script).toContain(`'/tmp/cindy-0.0.2-amd64.deb'`);
  });

  it('passes the manifest sha256 and deb path as argv to the elevated shell', () => {
    expect(script).toContain(
      `"$PKEXEC" /bin/bash -c "$ELEVATED" bash '${STAGED_SHA}' '/tmp/cindy-0.0.2-amd64.deb'`,
    );
  });

  it('never hands the user-replaceable log path to the elevated root shell', () => {
    // 只取 ELEVATED 提权段本体(到结束引号为止),外层用户 shell 的重定向不在此列。
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf("fi'", script.indexOf('ELEVATED=')) + 3);
    expect(elevated).not.toContain('cindy-update.log');
    // 日志重定向由外层用户 shell 完成,提权进程只写 stdout/stderr。
    expect(script).toContain(
      `"$PKEXEC" /bin/bash -c "$ELEVATED" bash '${STAGED_SHA}' '/tmp/cindy-0.0.2-amd64.deb' ${STAGED_SIZE} >> '/tmp/cindy-update.log' 2>&1`,
    );
  });

  it('copies the .deb to a root-owned 0700 temp dir and hashes before installing', () => {
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf('"$PKEXEC" /bin/bash'));
    const copyIdx = elevated.indexOf('dd if="$2" of="$TMP/update.deb"');
    const hashIdx = elevated.indexOf('if [ "$ACTUAL" != "$1" ]');
    const aptIdx = elevated.indexOf('apt-get install');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(copyIdx);
    expect(aptIdx).toBeGreaterThan(hashIdx);
    expect(elevated).toContain('TMP=$(mktemp -d "${TMPDIR:-/tmp}/cindy-deb.XXXXXX")');
    expect(elevated).toContain('chmod 700 "$TMP"');
  });

  it('opens the staged source atomically with nofollow and a size-bounded copy', () => {
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf('"$PKEXEC" /bin/bash'));
    expect(elevated).toContain('if [ -L "$2" ] || [ ! -f "$2" ]; then');
    // 权威防线:dd 用 O_NOFOLLOW + O_NONBLOCK 原子打开,count 按清单大小封顶。
    expect(elevated).toContain('dd if="$2" of="$TMP/update.deb" iflag=nofollow,nonblock');
    expect(elevated).toContain('if [ "$WRITTEN" != "$3" ]; then');
    expect(script).toContain(
      `"$PKEXEC" /bin/bash -c "$ELEVATED" bash '${STAGED_SHA}' '/tmp/cindy-0.0.2-amd64.deb' ${STAGED_SIZE} >> '/tmp/cindy-update.log' 2>&1`,
    );
  });

  it('does not run dpkg/apt outside the elevated pkexec shell', () => {
    const outside = script.slice(script.indexOf('ELEVATED='));
    // 除 ELEVATED 内的安装器,外层脚本里只允许 pkexec /bin/bash 一条特权调用。
    const pkexecCalls = outside.match(/"\$PKEXEC"/g) ?? [];
    expect(pkexecCalls).toHaveLength(1);
    expect(outside).toContain('"$PKEXEC" /bin/bash -c "$ELEVATED"');
  });

  it('keeps the update lock alive and writes the updater pid into it', () => {
    const lockIdx = script.indexOf(`echo updating $$ > '/tmp/cindy-update.lock'`);
    const pkexecIdx = script.indexOf('"$PKEXEC" /bin/bash');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(pkexecIdx).toBeGreaterThan(lockIdx);
    // 锁内容带 $$(updater shell 自己的 PID),bootstrap 据此判定持有者是否存活。
    const heartbeatLines = script.split('\n').filter((l) => l.includes('echo updating'));
    expect(heartbeatLines.length).toBeGreaterThanOrEqual(2);
    expect(script).toContain('LOCK_HEARTBEAT_PID=$!');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain("rm -f '/tmp/cindy-update.lock'");
    // 心跳先看父 bash 存活;父死后按进程组扫描(输出落文件,pgrep 自排除,
    // 心跳辅助进程不会误计),组里还有活成员(含孤儿 apt/dpkg 后代)就以
    // $BASHPID 写锁继续持锁。心跳自己也被排除在扫描外,不会让 cleanup
    // 误判成「还有别人」。
    expect(script).toContain('if kill -0 "$LOCK_PARENT" 2>/dev/null; then');
    expect(script).toContain('scan_group_others()');
    expect(script).toContain('GROUPFILE=');
    expect(script).toContain('echo updating "$BASHPID" >');
    expect(script).toContain('[ "$GPID" = "$LOCK_HEARTBEAT_PID" ] && continue');
    // 组文件用 mktemp 私有临时文件,不用可预测的 <lock>.group 路径;
    // 枚举失败(mktemp 失败或 pgrep 重定向失败)必须 fail closed 成
    // OTHERS=1,当作「安装链可能还在」,绝不能清锁让新实例在 apt 还在
    // 替换文件时启动。
    expect(script).toContain('GROUPFILE=$(mktemp "');
    expect(script).toContain('|| { OTHERS=1; return 0; }');
    expect(script).toContain('if ! pgrep -g "$LOCK_PGID" > "$GROUPFILE" 2>/dev/null; then');
    expect(script).not.toContain('cindy-update.lock.group');
    // 拉起走 relaunch_app:先杀心跳清锁,再 setsid 脱离本进程组,
    // 新 Cindy 不会被误判成安装链,也不会卡在自己的锁上。
    expect(script).toContain('relaunch_app()');
    expect(script).toContain('setsid nohup');
    // 锁和心跳在任何日志 append 之前就位:日志被换成 FIFO 也不影响持锁。
    const logIdx = script.indexOf("Update script started");
    expect(lockIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(lockIdx);
  });

  it('rejects a missing or malformed sha256 instead of installing unverified bytes', () => {
    expect(() => buildLinuxUpdateScript(makeParams({ sha256: 'abc' }))).toThrow(/sha256/);
  });

  it('escalates SIGKILL at exitKillAfterSeconds and aborts at exitAbortAfterSeconds', () => {
    const t = DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS;
    const killIdx = script.indexOf(`-eq ${t.exitKillAfterSeconds} `);
    const abortIdx = script.indexOf(`-ge ${t.exitAbortAfterSeconds} `);
    expect(killIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(killIdx);
    const abortBlock = script.slice(abortIdx, script.indexOf('done', abortIdx));
    expect(abortBlock).toContain('exit 1');
    expect(script.slice(killIdx, abortIdx)).toContain('kill -9 12345');
  });

  it('relaunches the previous binary if install fails', () => {
    expect(script).toContain('INSTALL FAILED — relaunching previous binary');
    expect(script).toContain(`nohup '/usr/lib/cindy/Cindy' >/dev/null 2>&1 &`);
  });

  it('releases the lock before relaunch and verifies by spawned child pid', () => {
    // 先放锁再拉起:新进程不会卡在 bootstrap 等自己的锁,2s 启动窗口后
    // 按启动的子 PID(kill -0)验证,等锁的旧实例不会被误判。
    const rmIdx = script.indexOf(`rm -f '/tmp/cindy-update.lock'`);
    const nohupIdx = script.indexOf(`nohup '/usr/lib/cindy/Cindy' >/dev/null 2>&1 &`);
    expect(rmIdx).toBeGreaterThan(-1);
    expect(nohupIdx).toBeGreaterThan(rmIdx);
    expect(script).toContain('LAUNCHED_PID=$!');
    expect(script).toContain('if kill -0 "$LAUNCHED_PID" 2>/dev/null; then');
    expect(script).toContain('sleep 2');
  });

  it('waits for the heartbeat to exit before removing the lock', () => {
    // kill 只发信号不保证退出,bash 在 sleep 里会推迟 SIGTERM;relaunch_app 与
    // cleanup 都必须在 rm 锁之前 wait 心跳,避免它醒来后再写一次锁。
    const killIdx = script.indexOf(`kill "$LOCK_HEARTBEAT_PID" 2>/dev/null`);
    expect(killIdx).toBeGreaterThan(-1);
    const waitIdx = script.indexOf(`wait "$LOCK_HEARTBEAT_PID" 2>/dev/null`);
    expect(waitIdx).toBeGreaterThan(killIdx);
    // wait 必须在任何 rm 锁之前。
    const firstLockRm = script.indexOf(`rm -f '/tmp/cindy-update.lock'`);
    expect(firstLockRm).toBeGreaterThan(waitIdx);
    // relaunch_app 与 cleanup 两处都应 wait(≥2 处)。
    const waitCount = (script.match(/wait "\$LOCK_HEARTBEAT_PID" 2>\/dev\/null/g) ?? []).length;
    expect(waitCount).toBeGreaterThanOrEqual(2);
  });

  it.runIf(process.platform !== 'win32')('renders to valid bash (bash -n)', () => {
    const tmp = path.join(os.tmpdir(), `cindy-linux-script-syntax-${process.pid}.sh`);
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    try {
      execFileSync('/bin/bash', ['-n', tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
