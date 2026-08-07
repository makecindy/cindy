/**
 * 对外模型代理的 IPC 层。渲染层设置页(模型供应商 → 模型代理子区块)经这些通道读写状态。
 *
 * 安全约束(勿改):
 *   - 所有**写**通道(set-enabled / set-default-provider / regenerate-token / set-port /
 *     write-external-config / copy-*)都过 `assertTrustedAppRendererEvent` —— 只允许 Cindy 自有
 *     顶层页面发起,插件面板 / webview 无法触达。
 *   - **token 明文绝不回传 renderer**:复制到剪贴板由 `copy-*` 通道在**主进程**里
 *     `clipboard.writeText` 完成,只回 `{success}`;写用户配置的明文也只在 main 落文件。
 *     `get-state` 与两个 preview 通道给 renderer 的一律是掩码。`assertTrustedAppRendererEvent`
 *     只验来源帧、不验用户手势,所以哪怕来源可信也不把明文交给可能被注入的渲染进程。
 */

import { clipboard, ipcMain } from 'electron';

import type {
  LocalProxyCodexConfigPreviewResult,
  LocalProxyConfigPreviewResult,
  LocalProxyConfigWriteResult,
  LocalProxyCopyResult,
  LocalProxyMutationResult,
  LocalProxyServiceState,
} from '../../shared/localProxyService.js';
import {
  MASK_FALLBACK,
  maskAnthropicPreview,
  maskCodexPreview,
} from './preview-masking.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  disposeAnthropicExternalProxy,
  ensureAnthropicExternalProxyReady,
  getExternalProxyUrl,
  portFromProxyUrl,
  restartAnthropicExternalProxy,
} from '../maker-host/anthropic-compat-proxy-host.js';
import {
  codexPortFromProxyUrl,
  disposeCodexExternalProxy,
  ensureCodexExternalProxyReady,
  getCodexExternalProxyUrl,
  restartCodexExternalProxy,
} from '../maker-host/codex-proxy-host.js';
import { listExternalRoutableProviders } from '../maker-host/provider-route.js';
import {
  clearExternalTokenMemoryFallback,
  getExternalTokenMasked,
  getOrCreateExternalToken,
  hasExternalToken,
  regenerateExternalToken,
  getCodexExternalTokenMasked,
  getOrCreateCodexExternalToken,
  hasCodexExternalToken,
  regenerateCodexExternalToken,
} from '../maker-host/local-proxy-external-auth.js';
import { addProviderSecretsClearedListener } from '../secrets/providerSecretStore.js';
import {
  isCodexExternalAccessEnabled,
  isExternalAccessEnabled,
  isValidLocalProxyPortOrAuto,
  loadLocalProxySettings,
  setLocalProxyCodexDefaultProviderId,
  setLocalProxyCodexEnabled,
  setLocalProxyCodexPort,
  setLocalProxyDefaultProviderId,
  setLocalProxyEnabled,
  setLocalProxyPort,
} from '../maker-host/local-proxy-settings-store.js';
import {
  previewExternalConfig,
  writeExternalConfig,
} from './external-config-writer.js';
import {
  previewCodexConfig,
  writeCodexConfig,
} from './codex-external-config-writer.js';

/** 组装设置页所需的全部非明文状态(单一事实源,各写通道改完都回读它)。 */
function buildState(): LocalProxyServiceState {
  const settings = loadLocalProxySettings();
  return {
    enabled: settings.enabled,
    url: getExternalProxyUrl(),
    port: settings.port,
    hasToken: hasExternalToken(),
    maskedToken: getExternalTokenMasked(),
    providers: listExternalRoutableProviders(),
    defaultProviderId: settings.defaultProviderId,
    // ── Codex / 通用 OpenAI 出口(第三期:独立开关 + 独立 token,另一个 loopback 端口)──
    codexEnabled: settings.codexEnabled,
    codexHasToken: hasCodexExternalToken(),
    codexMaskedToken: getCodexExternalTokenMasked(),
    codexUrl: getCodexExternalProxyUrl(),
    codexPort: settings.codexPort,
    codexProviders: listExternalRoutableProviders('codex'),
    codexDefaultProviderId: settings.codexDefaultProviderId,
  };
}

/** 主进程侧把明文写进系统剪贴板;明文不出 main。 */
function copyToClipboardInMain(text: string): LocalProxyCopyResult {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerLocalProxyServiceIpc(): void {
  // 账号边界清理(切换账号 / 清空 secrets)时,providerSecretStore 会删掉两族物理 token。
  // 但 safeStorage 写失败时留下的进程内兜底 token 不经 secretStore,必须在同一路径上一并清掉,
  // 否则旧账号的对外 token 会跨账号存活、在新账号下仍被判定命中(串到新账号付费凭证)。
  addProviderSecretsClearedListener(clearExternalTokenMemoryFallback);

  ipcMain.handle('local-proxy:get-state', async (): Promise<LocalProxyServiceState> =>
    buildState());

  // 开启 A 族(Anthropic / Claude Code)对外服务:①确保已有 A 族 token;②拉起**独立的对外
  // loopback 端口**(端口拆分,#1666:内部 cc 子进程代理与对外端口不再共用一个 handle);③未固定
  // 端口时捕获其实际端口并持久化,让外部 CLI 的 ANTHROPIC_BASE_URL 从此稳定。关闭则置
  // enabled=false 并**关掉对外端口**(不再监听公开端口,外部直接连不上;端口设置保留,下次开启复用)。
  // B 族(Codex)有独立开关,互不影响。
  ipcMain.handle(
    'local-proxy:set-enabled',
    async (event, enabled: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'invalid enabled flag', state: buildState() };
      }
      if (enabled) {
        getOrCreateExternalToken();
        try {
          await ensureAnthropicExternalProxyReady();
          // 未固定端口时,捕获对外 handle 的实际(随机)端口固定下来。
          if (loadLocalProxySettings().port <= 0) {
            const url = getExternalProxyUrl();
            const running = url ? portFromProxyUrl(url) : null;
            if (running) setLocalProxyPort(running);
          }
        } catch {
          // 对外端口起不来不阻断开关置位;url 会保持 null,UI 侧据此提示未就绪。
        }
      } else {
        await disposeAnthropicExternalProxy();
      }
      setLocalProxyEnabled(enabled);
      return { success: true, state: buildState() };
    },
  );

  // 开启 B 族(Codex / 通用 OpenAI)对外服务:①确保已有 B 族独立 token;②拉起**独立的对外 codex
  // loopback 端口**(端口拆分,#1666 Finding 2:内部 codex 子进程代理与对外端口不再共用一个 handle);
  // ③未固定端口时捕获其实际端口并持久化,让外部 codex/OpenAI 客户端 base_url 稳定。关闭则置
  // codexEnabled=false 并**关掉对外端口**(端口设置保留,下次开启复用)。A 族(Anthropic)有独立开关。
  ipcMain.handle(
    'local-proxy:set-codex-enabled',
    async (event, enabled: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'invalid enabled flag', state: buildState() };
      }
      if (enabled) {
        getOrCreateCodexExternalToken();
        try {
          await ensureCodexExternalProxyReady();
          if (loadLocalProxySettings().codexPort <= 0) {
            const codexUrl = getCodexExternalProxyUrl();
            const codexRunning = codexUrl ? codexPortFromProxyUrl(codexUrl) : null;
            if (codexRunning) setLocalProxyCodexPort(codexRunning);
          }
        } catch {
          // codex 对外端口起不来不阻断开关置位;codexUrl 会保持 null,UI 侧据此提示未就绪。
        }
      } else {
        await disposeCodexExternalProxy();
      }
      setLocalProxyCodexEnabled(enabled);
      return { success: true, state: buildState() };
    },
  );

  ipcMain.handle(
    'local-proxy:set-default-provider',
    async (event, providerId: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof providerId !== 'string') {
        return { success: false, error: 'invalid provider id', state: buildState() };
      }
      // 允许空串(= 清空默认供应商);非空时必须是当前可路由候选之一,防写入陈旧/不可用 id。
      const trimmed = providerId.trim();
      if (trimmed.length > 0 && !listExternalRoutableProviders().some((p) => p.id === trimmed)) {
        return { success: false, error: 'provider not routable', state: buildState() };
      }
      setLocalProxyDefaultProviderId(trimmed);
      return { success: true, state: buildState() };
    },
  );

  // 重新生成对外 token(旧 token 立即失效)。只回掩码后的最新 state;要复制明文走
  // copy-token / copy-env(main 侧落剪贴板)。
  ipcMain.handle(
    'local-proxy:regenerate-token',
    async (event): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      try {
        regenerateExternalToken();
      } catch (err) {
        // 轮换失败(旧物理 token 无法失效)→ 如实回失败,别谎报成功让旧 token 继续鉴权。
        return { success: false, error: (err as Error).message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // 重新生成 B 族(Codex / 通用 OpenAI)独立对外 token(旧 token 立即失效,不影响 A 族)。
  ipcMain.handle(
    'local-proxy:regenerate-codex-token',
    async (event): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      try {
        regenerateCodexExternalToken();
      } catch (err) {
        return { success: false, error: (err as Error).message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // 手改固定端口:校验区间 → 持久化 → 重建 proxy 让新端口生效(会中断经代理的 in-flight 请求)。
  // 端口被占用时 host 内部会 fallback 随机并回写,故重建后回读的 state.url 反映实际绑定值。
  ipcMain.handle(
    'local-proxy:set-port',
    async (event, port: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isValidLocalProxyPortOrAuto(port)) {
        return { success: false, error: 'invalid port', state: buildState() };
      }
      setLocalProxyPort(port);
      try {
        await restartAnthropicExternalProxy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // 复制 A 族对外 token 明文到系统剪贴板 —— 明文只在 main 落剪贴板,不回传 renderer。
  ipcMain.handle(
    'local-proxy:copy-token',
    async (event): Promise<LocalProxyCopyResult> => {
      assertTrustedAppRendererEvent(event);
      if (!getExternalProxyUrl()) return { success: false, error: 'proxy not ready' };
      return copyToClipboardInMain(getOrCreateExternalToken());
    },
  );

  // 复制 A 族完整 env(两条 `export` 行)到系统剪贴板。带 export 前缀:粘进 shell 后是两条独立、
  // 可直接运行的语句(子进程 claude 才能继承这两个变量;裸 `KEY=value` 只是当前 shell 局部变量,
  // 不会传给子进程)。明文只在 main 落剪贴板,不回传 renderer。
  ipcMain.handle(
    'local-proxy:copy-env',
    async (event): Promise<LocalProxyCopyResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getExternalProxyUrl();
      if (!url) return { success: false, error: 'proxy not ready' };
      const token = getOrCreateExternalToken();
      return copyToClipboardInMain(
        `export ANTHROPIC_BASE_URL=${url}\nexport ANTHROPIC_API_KEY=${token}`,
      );
    },
  );

  // 写用户 ~/.claude 配置前的预览(展示改动 + 冲突项,由 UI 二次确认)。token 段掩码后再回
  // renderer;真实明文只在 write-external-config 落文件。
  ipcMain.handle(
    'local-proxy:preview-external-config',
    async (event): Promise<LocalProxyConfigPreviewResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getExternalProxyUrl();
      if (!url) {
        return { success: false, error: 'proxy not ready' };
      }
      const token = getOrCreateExternalToken();
      try {
        const masked = getExternalTokenMasked() ?? MASK_FALLBACK;
        return { success: true, preview: maskAnthropicPreview(previewExternalConfig(url, token), token, masked) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 非破坏性写入用户 ~/.claude 配置。仅用户在预览后主动确认时调用。
  ipcMain.handle(
    'local-proxy:write-external-config',
    async (event): Promise<LocalProxyConfigWriteResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getExternalProxyUrl();
      if (!url) {
        return { success: false, error: 'proxy not ready' };
      }
      const token = getOrCreateExternalToken();
      return writeExternalConfig(url, token);
    },
  );

  // ───────── 第二期:Codex / 通用 OpenAI 出口专属通道 ─────────

  // codex「对外默认供应商」。空串 = 清空;非空须是 codex agent 当前可路由候选之一。
  ipcMain.handle(
    'local-proxy:set-codex-default-provider',
    async (event, providerId: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (typeof providerId !== 'string') {
        return { success: false, error: 'invalid provider id', state: buildState() };
      }
      const trimmed = providerId.trim();
      if (
        trimmed.length > 0 &&
        !listExternalRoutableProviders('codex').some((p) => p.id === trimmed)
      ) {
        return { success: false, error: 'provider not routable', state: buildState() };
      }
      setLocalProxyCodexDefaultProviderId(trimmed);
      return { success: true, state: buildState() };
    },
  );

  // 手改 codex 对外 loopback 固定端口:校验 → 持久化 → 重建**对外** codex proxy 让新端口生效
  // (会中断经该对外 loopback 的 in-flight 请求;被占用时 host 内部 fallback 随机并回写)。
  ipcMain.handle(
    'local-proxy:set-codex-port',
    async (event, port: unknown): Promise<LocalProxyMutationResult> => {
      assertTrustedAppRendererEvent(event);
      if (!isValidLocalProxyPortOrAuto(port)) {
        return { success: false, error: 'invalid port', state: buildState() };
      }
      setLocalProxyCodexPort(port);
      try {
        await restartCodexExternalProxy();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, state: buildState() };
      }
      return { success: true, state: buildState() };
    },
  );

  // 复制 B 族(Codex)对外 token 明文到系统剪贴板。明文只在 main 落剪贴板,不回传 renderer。
  ipcMain.handle(
    'local-proxy:copy-codex-token',
    async (event): Promise<LocalProxyCopyResult> => {
      assertTrustedAppRendererEvent(event);
      if (!getCodexExternalProxyUrl()) return { success: false, error: 'codex proxy not ready' };
      return copyToClipboardInMain(getOrCreateCodexExternalToken());
    },
  );

  // 复制 B 族完整 env(OPENAI_BASE_URL/OPENAI_API_KEY 两条 export 行)到系统剪贴板。
  ipcMain.handle(
    'local-proxy:copy-codex-env',
    async (event): Promise<LocalProxyCopyResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexExternalProxyUrl();
      if (!url) return { success: false, error: 'codex proxy not ready' };
      const token = getOrCreateCodexExternalToken();
      return copyToClipboardInMain(
        `export OPENAI_BASE_URL=${url}\nexport OPENAI_API_KEY=${token}`,
      );
    },
  );

  // 复制 codex 需自设的 `export CINDY_LOCAL_TOKEN=<token>` 行到系统剪贴板(写 config.toml 弹窗里
  // 那行掩码展示,真实明文经此通道复制)。明文只在 main 落剪贴板,不回传 renderer。
  ipcMain.handle(
    'local-proxy:copy-codex-token-export',
    async (event): Promise<LocalProxyCopyResult> => {
      assertTrustedAppRendererEvent(event);
      if (!getCodexExternalProxyUrl()) return { success: false, error: 'codex proxy not ready' };
      return copyToClipboardInMain(`export CINDY_LOCAL_TOKEN=${getOrCreateCodexExternalToken()}`);
    },
  );

  // 写用户 ~/.codex/config.toml 前的预览(展示 merge 后 TOML + 冲突 + 需自设的 token env 行)。
  // token export 行掩码后再回 renderer;真实明文走 copy-codex-token-export。
  ipcMain.handle(
    'local-proxy:preview-codex-config',
    async (event): Promise<LocalProxyCodexConfigPreviewResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexExternalProxyUrl();
      if (!url) {
        return { success: false, error: 'codex proxy not ready' };
      }
      const token = getOrCreateCodexExternalToken();
      try {
        const masked = getCodexExternalTokenMasked() ?? MASK_FALLBACK;
        return { success: true, preview: maskCodexPreview(previewCodexConfig(url, token), token, masked) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 非破坏性写入用户 ~/.codex/config.toml。仅用户在预览后主动确认时调用。token 不入文件。
  ipcMain.handle(
    'local-proxy:write-codex-config',
    async (event): Promise<LocalProxyConfigWriteResult> => {
      assertTrustedAppRendererEvent(event);
      const url = getCodexExternalProxyUrl();
      if (!url) {
        return { success: false, error: 'codex proxy not ready' };
      }
      return writeCodexConfig(url);
    },
  );

  // boot 期:两族各自独立开启时,对应的对外 loopback 应在启动时就绪(而非等下次点开关)——
  // 与「每族可独立开」一致。端口拆分后 A 族对外端口是独立 handle(不再随内部 cc 代理常驻),
  // 故 A 族也要在此按 enabled 拉起。fire-and-forget,起不来不阻断 IPC 注册(UI 侧据 url/codexUrl=null
  // 提示未就绪)。内部 cc 子进程代理仍由 anthropic host 在 boot 常驻,与此处的对外端口无关。
  if (isExternalAccessEnabled()) {
    void ensureAnthropicExternalProxyReady().catch(() => {
      // 对外端口起不来不阻断启动;url 保持 null,UI 侧提示未就绪。
    });
  }
  if (isCodexExternalAccessEnabled()) {
    void ensureCodexExternalProxyReady().catch(() => {
      // codex 对外端口起不来不阻断启动;codexUrl 保持 null,UI 侧提示未就绪。
    });
  }
}
