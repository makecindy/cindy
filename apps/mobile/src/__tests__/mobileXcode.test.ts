// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseMobileXcodeArgs,
  selectMobileXcodeWorkspace,
  updateMobileXcodeEnvContent,
} from '../../scripts/lib/mobile-xcode.mjs';
import {
  extractMobileDevRegionArgs,
  withLocalMobileRegionConfig,
} from '../../scripts/lib/mobile-dev-region.mjs';

describe('mobile:xcode 参数', () => {
  it('不传 region 时默认 global', () => {
    expect(parseMobileXcodeArgs([])).toEqual({ help: false, region: 'global' });
  });

  it('支持 --region value / --region=value 与 pnpm 的分隔符', () => {
    expect(parseMobileXcodeArgs(['--region', 'cn'])).toEqual({ help: false, region: 'cn' });
    expect(parseMobileXcodeArgs(['--', '--region=global'])).toEqual({ help: false, region: 'global' });
  });

  it('region 只允许 cn / global / dev', () => {
    expect(() => parseMobileXcodeArgs(['--region', 'us'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => parseMobileXcodeArgs(['--region'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => parseMobileXcodeArgs(['--region', ''])).toThrow(/只能是 cn 或 global 或 dev/);
  });
});

describe('mobile simulator region 参数', () => {
  it('默认 global，并仅移除 region 参数', () => {
    expect(extractMobileDevRegionArgs(['--port', '8082'])).toEqual({
      region: 'global',
      passthrough: ['--port', '8082'],
    });
    expect(extractMobileDevRegionArgs(['--', '--region=global', '--clean'])).toEqual({
      region: 'global',
      passthrough: ['--clean'],
    });
  });

  it('拒绝非法或重复 region', () => {
    expect(() => extractMobileDevRegionArgs(['--region=us'])).toThrow(/只能是 cn 或 global 或 dev/);
    expect(() => extractMobileDevRegionArgs(['--region=cn', '--region=global'])).toThrow(/只能传一次/);
  });

  it('把所选 region 直接注入 Metro 子进程，不被 shell 残留值覆盖', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/sim-start.mjs'), 'utf8');
    expect(source).toContain('const buildEnv = withLocalMobileRegionConfig(');
    expect(source).toContain('...process.env,\n    ...buildEnv,');
  });

  it('所有本地构建环境都启用 region JSON 配置源', () => {
    expect(withLocalMobileRegionConfig({ EXPO_PUBLIC_CINDY_AUTH_REGION: 'global' }))
      .toEqual({
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
        CINDY_USE_LOCAL_REGION_CONFIG: '1',
      });
  });
});

describe('mobile:xcode env 切换', () => {
  it('覆盖地区键、去掉重复定义并保留其它本地配置', () => {
    const source = [
      '# local settings',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=stale',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://cn.example',
      'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me',
      '',
    ].join('\n');
    const next = updateMobileXcodeEnvContent(source, {
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://global.example',
      CINDY_USE_LOCAL_REGION_CONFIG: '1',
    });

    expect(next.match(/EXPO_PUBLIC_CINDY_AUTH_REGION=/g)).toHaveLength(1);
    expect(next).toContain('EXPO_PUBLIC_CINDY_AUTH_REGION=global');
    expect(next).toContain('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://global.example');
    expect(next).toContain('CINDY_USE_LOCAL_REGION_CONFIG=1');
    expect(next).toContain('EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me');
  });
});

describe('mobile:xcode workspace 选择', () => {
  it('只选 app workspace，忽略 Pods workspace', () => {
    expect(selectMobileXcodeWorkspace('/repo/apps/mobile/ios', [
      'Pods.xcworkspace',
      'Cindy.xcworkspace',
      'Podfile',
    ])).toBe(join('/repo/apps/mobile/ios', 'Cindy.xcworkspace'));
  });

  it('缺失或出现多个 app workspace 时 fail closed', () => {
    expect(() => selectMobileXcodeWorkspace('/ios', ['Podfile'])).toThrow(/未在 .* 找到/);
    expect(() => selectMobileXcodeWorkspace('/ios', ['A.xcworkspace', 'B.xcworkspace'])).toThrow(/找到多个/);
  });
});

describe('mobile:xcode 完整开发链路', () => {
  it('打开 Xcode 后复用 sim:start 启动带 worktree/port 防护的 Metro', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/open-ios-xcode.mjs'), 'utf8');
    expect(source).toContain("resolve(mobileDir, 'scripts/sim-start.mjs')");
    expect(source).toContain('await portInUse(metroPort)');
    expect(source).toContain('execFileSync(process.execPath, [simStartPath, `--region=${args.region}`]');
  });
});
