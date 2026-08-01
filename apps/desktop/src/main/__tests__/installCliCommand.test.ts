/**
 * installCliCommand 纯函数单测:symlink 目标路径推导、install/uninstall shell 命令拼装、
 * shell/AppleScript 转义、权限与「用户取消授权」判定,以及随包分发的启动器脚本自检。
 * 不触发真实 symlink 或 osascript(那些路径需 packaged + 用户授权,见模块头注释,
 * 端到端只能打包验证)。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import { describe, expect, it } from 'vitest';

import {
  CLI_COMMAND_NAME,
  CLI_LINK_PATH,
  __testing,
  buildInstallShellCommand,
  buildUninstallShellCommand,
  resolveBundledCliPath,
} from '../installCliCommand';

describe('CLI_COMMAND_NAME 跟随 edition 品牌', () => {
  it('测试环境(未注入区域 → 默认 global)命令名为 cindy', () => {
    expect(CLI_COMMAND_NAME).toBe('cindy');
    expect(CLI_LINK_PATH).toBe('/usr/local/bin/cindy');
  });

  it('由区域可执行名小写化:global / cn → cindy,内部 dev → cindydev', () => {
    // global 与 cn 展示名统一为 Cindy(2026-07-26 决策),故命令名同为 cindy。
    expect(brandExecutableName('global').toLowerCase()).toBe('cindy');
    expect(brandExecutableName('cn').toLowerCase()).toBe('cindy');
    expect(brandExecutableName('dev').toLowerCase()).toBe('cindydev');
  });
});

describe('resolveBundledCliPath', () => {
  it('由 resourcesPath 推出包内 cli/cindy', () => {
    expect(resolveBundledCliPath('/Applications/Cindy.app/Contents/Resources')).toBe(
      '/Applications/Cindy.app/Contents/Resources/cli/cindy',
    );
  });

  it('路径含空格也正确', () => {
    expect(resolveBundledCliPath('/Users/a/My Apps/Cindy.app/Contents/Resources')).toBe(
      '/Users/a/My Apps/Cindy.app/Contents/Resources/cli/cindy',
    );
  });
});

describe('buildInstallShellCommand', () => {
  it('mkdir -p 链接目录、拒绝真实目录后 ln -sfn 目标到 source', () => {
    const cmd = buildInstallShellCommand(
      '/Applications/Cindy.app/Contents/Resources/cli/cindy',
      CLI_LINK_PATH,
    );
    expect(cmd).toBe(
      `mkdir -p '/usr/local/bin' && if [ -d '/usr/local/bin/cindy' ] && [ ! -L '/usr/local/bin/cindy' ]; then echo '/usr/local/bin/cindy is a directory' >&2; exit 1; fi && ln -sfn '/Applications/Cindy.app/Contents/Resources/cli/cindy' '/usr/local/bin/cindy'`,
    );
  });

  it('用 -sfn 而非 -sf(macOS 上替换指向目录的旧 symlink,不解引用进目录)', () => {
    const cmd = buildInstallShellCommand('/App/Cindy.app/Contents/Resources/cli/cindy', CLI_LINK_PATH);
    expect(cmd).toContain(`ln -sfn `);
    expect(cmd).not.toContain(`ln -sf `);
  });

  it('含单引号的路径被安全转义', () => {
    const cmd = buildInstallShellCommand(`/Users/o'brien/Cindy.app/Contents/Resources/cli/cindy`, CLI_LINK_PATH);
    expect(cmd).toContain(`'/Users/o'\\''brien/Cindy.app/Contents/Resources/cli/cindy'`);
  });
});

describe('buildUninstallShellCommand', () => {
  it('仅当目标是 symlink 时才 rm -f(不误删同路径普通文件,并发移除也幂等)', () => {
    expect(buildUninstallShellCommand(CLI_LINK_PATH)).toBe(
      `if [ -L '/usr/local/bin/cindy' ]; then rm -f '/usr/local/bin/cindy'; fi`,
    );
  });

  it('含单引号的路径两处引用都被安全转义', () => {
    const cmd = buildUninstallShellCommand(`/usr/local/bin/o'brien`);
    expect(cmd).toBe(
      `if [ -L '/usr/local/bin/o'\\''brien' ]; then rm -f '/usr/local/bin/o'\\''brien'; fi`,
    );
  });
});

describe('shellSingleQuote', () => {
  const { shellSingleQuote } = __testing;

  it('普通路径直接包单引号', () => {
    expect(shellSingleQuote('/usr/local/bin/cindy')).toBe(`'/usr/local/bin/cindy'`);
  });

  it("内部单引号转义为 '\\''", () => {
    expect(shellSingleQuote(`a'b`)).toBe(`'a'\\''b'`);
  });
});

describe('escapeForAppleScriptString', () => {
  const { escapeForAppleScriptString } = __testing;

  it('转义反斜杠与双引号', () => {
    expect(escapeForAppleScriptString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('单引号(shell 用)不受影响', () => {
    expect(escapeForAppleScriptString(`ln -sf '/a/b' '/c/d'`)).toBe(`ln -sf '/a/b' '/c/d'`);
  });
});

describe('isPermissionError', () => {
  const { isPermissionError } = __testing;

  it('识别 EACCES / EPERM / EROFS', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      expect(isPermissionError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('其它错误返回 false', () => {
    expect(isPermissionError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false);
    expect(isPermissionError(new Error('plain'))).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });
});

describe('isUserCancelledAdmin', () => {
  const { isUserCancelledAdmin } = __testing;

  it('识别 osascript 取消授权(-128 / User canceled)', () => {
    expect(isUserCancelledAdmin(new Error('osascript: User canceled.'))).toBe(true);
    expect(
      isUserCancelledAdmin(Object.assign(new Error('failed'), { stderr: 'execution error: ... (-128)' })),
    ).toBe(true);
  });

  it('普通失败返回 false', () => {
    expect(isUserCancelledAdmin(new Error('ln: permission denied'))).toBe(false);
    expect(isUserCancelledAdmin(undefined)).toBe(false);
  });
});

describe('随包分发的启动器脚本 resources/cli/cindy', () => {
  const scriptPath = path.resolve(
    fileURLToPath(import.meta.url),
    '../../../../resources/cli/cindy',
  );
  const script = readFileSync(scriptPath, 'utf8');

  it('是 sh 脚本', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('跟随 symlink 自定位并反推 .app', () => {
    expect(script).toContain('while [ -h "$SELF" ]; do');
    expect(script).toContain('readlink "$SELF"');
    // BIN_DIR/../../.. : cli → Resources → Contents → *.app
    expect(script).toContain('APP=$(cd "$BIN_DIR/../../.." >/dev/null 2>&1 && pwd)');
  });

  it('无参数仅唤起 app,单参数用 open -a 打开', () => {
    expect(script).toContain('if [ "$#" -eq 0 ]; then\n  exec open -a "$APP"');
    // -- 结束选项解析,避免以 - 开头的路径被 open 当成自身选项。
    expect(script).toContain('exec open -a "$APP" -- "$abs"');
  });

  it('拒绝多路径调用(避免冷启动 pending 槽互相覆盖、静默丢失)', () => {
    expect(script).toContain('if [ "$#" -gt 1 ]; then');
    expect(script).toContain('exit 2');
  });

  it('把单个参数解析为绝对路径(支持 cindy .)', () => {
    expect(script).toContain('abs=$(cd "$arg" >/dev/null 2>&1 && pwd)');
    expect(script).toContain('arg="$1"');
  });
});
