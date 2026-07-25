import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { darkColors, lightColors, motionDuration } from "@/theme/tokens";

/**
 * 启动 splash 覆盖层契约:启动闸门链全程共用根部一个常驻 splash 实例。
 * 回归背景:此前每道闸门(端点清单/canary 渠道/OTA 门/auth 恢复)各自渲染独立的
 * splash,交接 remount 会露出 surface 底色,产生"红→白→红"闪帧(2026-07 用户实报)。
 */
describe("startup splash overlay", () => {
  // Windows 检出(core.autocrlf)下源文件是 CRLF,归一化行尾让含 \n 的断言跨平台成立。
  const read = (rel: string) =>
    readFileSync(resolve(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

  it("root layout mounts a single persistent splash overlay above the gate chain", () => {
    const layout = read("app/_layout.tsx");

    expect(layout).toContain("from '@/components/StartupSplashOverlay'");
    expect(layout).toContain(
      "<StartupSplashOverlay hidden={endpointGate.status === 'error'}>",
    );
    // 闸门链各关不许再各自渲染 splash 实例(splash-preview 路由是唯一例外)。
    expect(layout).not.toContain('variant="splash"');
  });

  it("gates render null while pending instead of their own splash instance", () => {
    const layout = read("app/_layout.tsx");
    const index = read("app/index.tsx");

    expect(layout).toContain("if (!otaReady) {\n    return null;\n  }");
    expect(layout).toContain("if (!channel.ready) return null;");
    expect(index).toContain("if (!auth.initialized) return null;");
    expect(index).not.toContain('variant="splash"');
  });

  it("releases the overlay on auth.initialized so deep-link cold starts also release", () => {
    const layout = read("app/_layout.tsx");

    expect(layout).toContain("if (auth.initialized) releaseSplash();");
  });

  it("fades the Android native-frame bridge before releasing the outer overlay", () => {
    const overlay = read("src/components/StartupSplashOverlay.tsx");

    expect(overlay).toContain("useNativeDriver: true");
    expect(overlay).toContain("StyleSheet.absoluteFill");
    expect(overlay).toContain("<CenteredScreen");
    expect(overlay).toContain('variant="splash"');
    expect(overlay).toContain("nativeSplashHeroAsset");
    expect(overlay).toContain("colors.brandSplashBackground");
    expect(overlay).toContain("height: 128");
    expect(overlay).toContain("width: 128");
    expect(overlay).toContain("duration: motionDuration.fast");
    expect(motionDuration.fast).toBe(150);
    expect(overlay).toContain(
      "if (releaseRequested && !nativeBridgeMounted) setReleased(true);",
    );
    expect(overlay).toContain("handoffContext?.state.reducedMotion");
  });

  it("keeps iOS unchanged while Android uses a theme-independent brand anchor", () => {
    // ios/android 目录是 prebuild 产物(gitignored),app.json 是原生启动页的权威来源。
    // iOS 保留旧的红底无图配置;Android light/night 使用同一品牌红与同源 hero,
    // 不在原生 starting window 阶段猜测 JS 才能读取的「是否首启」状态。
    const appConfig = JSON.parse(read("app.json")) as {
      expo: { plugins: (string | [string, Record<string, unknown>])[] };
    };
    const splashPlugin = appConfig.expo.plugins.find(
      (p): p is [string, Record<string, unknown>] =>
        Array.isArray(p) && p[0] === "expo-splash-screen",
    );

    expect(splashPlugin).toBeDefined();
    const splashConfig = splashPlugin?.[1] as {
      backgroundColor?: string;
      image?: string;
      dark?: { backgroundColor?: string; image?: string };
      android?: {
        backgroundColor?: string;
        image?: string;
        imageWidth?: number;
        dark?: { backgroundColor?: string; image?: string };
      };
    };

    expect(splashConfig).not.toHaveProperty("image");
    expect(splashConfig.backgroundColor).toBe(
      lightColors.brandSplashBackground,
    );
    expect(splashConfig.dark).toEqual({
      backgroundColor: darkColors.brandSplashBackground,
    });
    expect(splashConfig.android).toEqual({
      backgroundColor: lightColors.brandSplashBackground,
      image: "./assets/login/login-hero@2x.png",
      imageWidth: 128,
      dark: {
        backgroundColor: darkColors.brandSplashBackground,
        image: "./assets/login/login-hero@2x.png",
      },
    });

    // Android 12 无 icon background 的安全圆直径是 192dp。prebuild 后对 288dp
    // splashscreen_logo 做 alpha 像素扫描,这份 hero 在 imageWidth=128 时的最远不透明
    // 像素半径为 53.6dp(<96dp)。锁住资产字节,后续换图必须重新做安全圆验证并更新契约。
    const heroSha256 = (file: string) =>
      createHash("sha256")
        .update(readFileSync(resolve(process.cwd(), file)))
        .digest("hex");
    expect(heroSha256("assets/login/login-hero@2x.png")).toBe(
      "4e0ce24b482ac28e1160ded2166a29a0054f497c5f63a21b7211805e9aa3ff01",
    );
    // JS bridge 的无倍率 require 在高密度设备会选 @3x，亦需锁住同构资产。
    expect(heroSha256("assets/login/login-hero@3x.png")).toBe(
      "d3cb03089d71e8f6cb6402ebce78009e5a72555380f81eaf932b74d96be0e8da",
    );
  });

  it("generates a dedicated Android splash icon and the same light/night brand background", () => {
    const nodeRequire = createRequire(import.meta.url);
    const expoCli = nodeRequire.resolve("expo/bin/cli");
    const introspected = JSON.parse(
      execFileSync(
        process.execPath,
        [expoCli, "config", "--type", "introspect", "--json"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, NODE_ENV: "development" },
        },
      ),
    ) as {
      _internal: {
        modResults: {
          android: {
            colors: { resources: { color: AndroidResource[] } };
            colorsNight: { resources: { color: AndroidResource[] } };
            styles: { resources: { style: AndroidStyle[] } };
          };
        };
      };
    };
    const android = introspected._internal.modResults.android;
    const splashStyle = android.styles.resources.style.find(
      (style) => style.$.name === "Theme.App.SplashScreen",
    );
    const splashItems = Object.fromEntries(
      (splashStyle?.item ?? []).map((item) => [item.$.name, item._]),
    );
    const colorValue = (resources: AndroidResource[]) =>
      resources.find((color) => color.$.name === "splashscreen_background")?._;

    expect(splashItems.windowSplashScreenAnimatedIcon).toBe(
      "@drawable/splashscreen_logo",
    );
    expect(splashItems.windowSplashScreenBackground).toBe(
      "@color/splashscreen_background",
    );
    expect(colorValue(android.colors.resources.color)).toBe(
      lightColors.brandSplashBackground,
    );
    expect(colorValue(android.colorsNight.resources.color)).toBe(
      darkColors.brandSplashBackground,
    );
  });
});

interface AndroidResource {
  _: string;
  $: { name: string };
}

interface AndroidStyle {
  $: { name: string };
  item?: AndroidResource[];
}
