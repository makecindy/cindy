/**
 * 用户在插件页、拖入或双击 `.cindy` 发起安装时的窗口级确认往返。
 *
 * 确认只投给发起安装的那个窗口（按 webContents id 绑定），也只接受那个窗口的回答；
 * 窗口销毁、导航、账号边界或超时都按取消结算，并通知窗口收起还开着的确认框。
 * Agent 发起的安装不走这里，走任务里的宿主权限确认卡（可在手机上确认）。
 *
 * 本模块不依赖 Electron，发送函数由 index.ts 注入，便于单测。
 */
import type { GhostInstallConsentRequest } from '../../shared/ghostInstallConsent.js';
import { WindowConfirmationBridge, type WindowConfirmationTarget } from '../windowConfirmationBridge.js';

type Consent = Omit<GhostInstallConsentRequest, 'requestId'>;
export type GhostInstallConsentWindowTarget = WindowConfirmationTarget<Consent>;

/** Preserve the plugin-specific contract and duplicate capability policy. */
export class GhostInstallConsentWindowBridge extends WindowConfirmationBridge<Consent> {
  constructor(deps: { timeoutMs?: number } = {}) {
    super({ ...deps, unavailableMessage: '没有可显示安装确认的窗口' });
  }

  override request(target: GhostInstallConsentWindowTarget, request: Consent): Promise<boolean> {
    return super.request(target, request, {
      key: request.purpose === 'task-capability' ? request.facts.ghostId : undefined,
    });
  }
}
