import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile splash preview route', () => {
  it('is gated to dev visual mock and renders the production splash variant', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/splash-preview.tsx'), 'utf8');

    expect(source).toContain("import { Redirect } from 'expo-router';");
    expect(source).toContain("import { CenteredScreen } from '@/components/CenteredScreen';");
    expect(source).toContain("import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';");
    expect(source).toContain('if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;');
    expect(source).toContain('<CenteredScreen title="Cindy" variant="splash" />');
    expect(source).not.toContain('process.env.EXPO_PUBLIC_CINDY_MOBILE_VISUAL_MOCK');
  });

  it('renders the splash variant through the wave4 brand host, not the legacy red splash assets', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/CenteredScreen.tsx'), 'utf8');

    // PR4a 白底体系:splash 变体 = MobileLoginHandoffStage 唯一品牌宿主
    expect(source).toContain(
      "import { MobileLoginHandoffStage } from '@/components/MobileLoginHandoffStage';",
    );
    expect(source).toContain('<MobileLoginHandoffStage');
    expect(source).toContain('testID="startup.splash"');
    // 渲染层不再 require 任何旧 splash 资产(fade 立绘 / 白版字标 / script)
    expect(source).not.toContain("require('../../assets/splash/");
    // 旧资产文件暂留原目录(后续清理批次统一处置),仅校验存在性不校验消费
    expect(
      existsSync(resolve(process.cwd(), 'assets/splash/cindy-splash-illustration-fade.webp')),
    ).toBe(true);
  });

  it('keeps the branded splash free of app loading spinner, status text and red splash theme', () => {
    const splashSource = readFileSync(resolve(process.cwd(), 'src/components/CenteredScreen.tsx'), 'utf8');
    const stageSource = readFileSync(
      resolve(process.cwd(), 'src/components/MobileLoginHandoffStage.tsx'),
      'utf8',
    );
    const layoutSource = readFileSync(resolve(process.cwd(), 'app/_layout.tsx'), 'utf8');
    const indexSource = readFileSync(resolve(process.cwd(), 'app/index.tsx'), 'utf8');

    // splash 变体不带 loading spinner / 副标题状态文案(品牌纯净屏;
    // ActivityIndicator 只存在于 default 变体分支)
    expect(splashSource).toContain('if (variant === \'splash\') {');
    expect(splashSource).not.toContain('colors.brandSplashMuted');
    // 红底主题族不再被 splash 渲染链消费(白底体系 = 主题 surface + 双红渐变)
    expect(splashSource).not.toContain('colors.brandSplashBackground');
    expect(stageSource).not.toContain('brandSplash');
    expect(stageSource).toContain('backgroundColor: colors.login.bgBase');
    expect(layoutSource).not.toContain('subtitle="正在检查更新" variant="splash"');
    expect(layoutSource).not.toContain('subtitle="正在启动" variant="splash"');
    expect(indexSource).not.toContain('subtitle="正在恢复登录状态" variant="splash"');
  });
});
