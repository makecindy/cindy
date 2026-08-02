/**
 * useVendorAuthGate —— vendor 未就绪时弹通用 confirmDialog,确认后跳 settings。
 *
 * Codex/Claude 聊天和语音输入共用这层门禁，避免每个入口各自维护一套
 * "缺连接/缺 API Key/缺组件" 的弹窗与跳转逻辑。
 *
 * 复用现有:
 *   - useVendorReadiness (cc / codex 的 ready/unauthenticated/binary-missing/loading)
 *   - voice-input:get-readiness (语音输入按当前 provider 判断 Codex/API Key)
 *   - useConfirmDialog (项目通用确认弹窗 Provider)
 *   - react-router-dom navigate
 *
 * 文案通过 i18n 构造,保持不同入口使用同一套 UI 语义。
 *
 * 调用方:
 *   const gate = useVendorAuthGate();
 *   const { proceed } = await gate.checkAndConfirm('cc'); // 或 'codex'
 *   if (!proceed) return;
 *   ... // ready,继续 send
 */

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  connectedProvidersForAgent,
  type AgentKind as ProviderAgentKind,
  type ProviderView,
} from '@cindy/model-providers';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useVendorReadiness, type Readiness } from '@/hooks/useVendorReadiness';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { AgentKind } from '@/lib/ccAgent.types';

interface DialogCopy {
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  settingsTab: SettingsTab;
}

type GatePurpose = 'send' | 'voice-input';
type SettingsTab = 'api-keys' | 'connections' | 'providers';

type CopyKey =
  | 'no-source'
  | 'voice-api-key-unauth'
  | 'voice-direct-api-key-unauth'
  | 'codex-voice-unauth'
  | 'codex-binary-missing'
  | 'pi-binary-missing';

function buildCopy(t: (key: string) => string): Record<CopyKey, DialogCopy> {
  return {
    // 无可用来源(cc / codex 同构):该 agent 一个已连接来源都没有 → 复用模型选择器同款
    // 「无可用来源 → 去连接」文案,跳供应商页。send 门禁与 agent 类型无关,两个 agent 共用这一条。
    'no-source': {
      title: t('newChat.noProvider.title'),
      description: t('newChat.noProvider.description'),
      confirmText: t('newChat.noProvider.connect'),
      cancelText: t('logic.confirm.cancel'),
      settingsTab: 'providers',
    },
    'voice-api-key-unauth': {
      title: t('logic.confirm.voiceApiKeyAuthTitle'),
      description: t('logic.confirm.voiceApiKeyAuthDescription'),
      confirmText: t('logic.confirm.goToSettings'),
      cancelText: t('logic.confirm.cancel'),
      settingsTab: 'providers',
    },
    'voice-direct-api-key-unauth': {
      title: t('logic.confirm.voiceDirectApiKeyAuthTitle'),
      description: t('logic.confirm.voiceDirectApiKeyAuthDescription'),
      confirmText: t('logic.confirm.goToSettings'),
      cancelText: t('logic.confirm.cancel'),
      // 「工具密钥」页已下架(2026-07-13),直连 key 引导落到模型供应商页。
      settingsTab: 'providers',
    },
    'codex-voice-unauth': {
      title: t('logic.confirm.codexVoiceAuthTitle'),
      description: t('logic.confirm.codexVoiceAuthDescription'),
      confirmText: t('logic.confirm.goToSettings'),
      cancelText: t('logic.confirm.cancel'),
      settingsTab: 'providers',
    },
    'codex-binary-missing': {
      title: t('logic.confirm.codexBinaryMissingTitle'),
      description: t('logic.confirm.codexBinaryMissingDescription'),
      confirmText: t('logic.confirm.goToSettings'),
      cancelText: t('logic.confirm.cancel'),
      settingsTab: 'providers',
    },
    'pi-binary-missing': {
      title: t('logic.confirm.piBinaryMissingTitle'),
      description: t('logic.confirm.piBinaryMissingDescription'),
      confirmText: t('logic.confirm.goToSettings'),
      cancelText: t('logic.confirm.cancel'),
      settingsTab: 'providers',
    },
  };
}

export function pickVoiceInputDialogCopy(
  copy: Record<CopyKey, DialogCopy>,
  readiness: { auth: 'api-key' | 'codex'; settingsTab: SettingsTab },
): DialogCopy {
  if (readiness.auth === 'codex') return copy['codex-voice-unauth'];
  if (readiness.settingsTab === 'providers') return copy['voice-api-key-unauth'];
  return copy['voice-direct-api-key-unauth'];
}

function pickCopy(
  copy: Record<CopyKey, DialogCopy>,
  vendor: AgentKind,
  readiness: Readiness,
): DialogCopy | null {
  if (readiness === 'binary-missing' && vendor === 'codex') return copy['codex-binary-missing'];
  if (readiness === 'binary-missing' && vendor === 'pi') return copy['pi-binary-missing'];
  if (readiness !== 'unauthenticated') return null;
  // 无可用来源:cc / codex 走同一条「连接来源」文案(send 门禁,与 agent 类型无关)。
  return copy['no-source'];
}

/**
 * device-link:推导**被控端**的 Readiness。纯函数,便于单测。
 *
 * 来源判定与本地(useVendorReadiness)/ 手机端同源:被控端 provider 目录里该 agent
 * 有已连接来源(`sourceReady`,隧道 maker:provider:list + connectedProvidersForAgent)
 * 即就绪。**不能**用 `maker:agent:status` 的 authReady 当来源门禁——它是 codex
 * OAuth / 网关 key 专属口径,认不出 provider 体系的其他来源(xAI / 通用 OAuth /
 * 自定义供应商),会把「没登 Codex 但配了其他 GPT 来源」的被控端误判成未登录。
 *
 * 三个输入均可为 null(= 对应查询失败 / 老被控端不支持):
 *   - binaryReady:codex 的运行时前提,false 优先返回 binary-missing(cc 随包,不参与);
 *   - sourceReady:provider 维度来源判定,可用时是唯一真相;
 *   - authReady:老被控端(allowlist 无 maker:provider:list)的回退口径,仅在
 *     sourceReady 不可用时消费,维持旧行为;
 *   - 全部不可用 → ready(控制端不臆断,放行交给被控端 create-session / send 权威校验)。
 */
export function deriveRemoteReadiness(
  vendor: AgentKind,
  input: {
    binaryReady: boolean | null;
    sourceReady: boolean | null;
    authReady: boolean | null;
  },
): Readiness {
  if (vendor !== 'cc' && input.binaryReady === false) {
    return 'binary-missing';
  }
  if (input.sourceReady !== null) return input.sourceReady ? 'ready' : 'unauthenticated';
  if (input.authReady !== null) return input.authReady ? 'ready' : 'unauthenticated';
  return 'ready';
}

/**
 * device-link:把隧道 `maker:provider:list` 的响应解析成 sourceReady。纯函数,便于单测。
 * 协议异常(providers 字段缺失 / 非数组)返回 null = 判定不可用,走 authReady 回退,
 * 而非把被控端误判成「无来源」。
 */
export function sourceReadyFromProviderList(
  value: unknown,
  agent: ProviderAgentKind,
  opts?: { includeSuspended?: boolean },
): boolean | null {
  const providers = (value as { providers?: ProviderView[] } | null)?.providers;
  if (!Array.isArray(providers)) return null;
  return connectedProvidersForAgent(providers, agent, {
    includeSuspended: opts?.includeSuspended === true,
  }).length > 0;
}

interface GateResult {
  proceed: boolean;
}

interface UseVendorAuthGateReturn {
  /**
   * 检查指定 vendor 的就绪状态:
   *   - unauthenticated → 弹 confirmDialog
   *       - 用户点确认 → navigate 到 /settings?tab=...,返回 { proceed: false }
   *       - 用户点取消 → 直接返回 { proceed: false }
   *   - codex binary-missing → 复用同一弹窗提示去连接页处理
   *   - 其他 (ready / loading) → { proceed: true },不拦截
   *
   * 语音输入会走 main 端 getReadiness,由当前 ASR provider 决定是检查
   * Codex 连接还是 API Key。
   *
   * device-link:传 `deviceId` 时(远程草稿 / 远程会话),就绪态以**被控端**为准——
   * 经隧道查被控端 `maker:provider:list`(来源判定)+ `maker:agent:status`(codex
   * binary 轴 / 老被控端回退),控制端本机有没有配 API Key / 连 Codex 无关。
   * 未就绪只弹纯信息弹窗(控制端无法代被控端跳设置),提示去那台设备配置。
   */
  checkAndConfirm: (
    vendor: AgentKind,
    options?: { purpose?: GatePurpose; deviceId?: string; existingSessionRoute?: boolean },
  ) => Promise<GateResult>;
}

export function useVendorAuthGate(): UseVendorAuthGateReturn {
  const navigate = useNavigate();
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();
  const copy = useMemo(() => buildCopy(t), [t]);
  const cc = useVendorReadiness('cc');
  const codex = useVendorReadiness('codex');
  const pi = useVendorReadiness('pi');

  const checkAndConfirm = useCallback(
    async (
      vendor: AgentKind,
      options?: { purpose?: GatePurpose; deviceId?: string; existingSessionRoute?: boolean },
    ): Promise<GateResult> => {
      if (options?.purpose === 'voice-input') {
        const readiness = await window.electronAPI.voiceInput.getReadiness();
        if (readiness.ok) return { proceed: true };

        const dialogCopy = pickVoiceInputDialogCopy(copy, readiness);
        const ok = await confirm({
          title: dialogCopy.title,
          description: dialogCopy.description,
          confirmText: dialogCopy.confirmText,
          cancelText: dialogCopy.cancelText,
          // 主操作("前往设置")是非破坏性的,默认焦点交给它,
          // 否则 Radix 默认聚焦 Cancel,会让"取消"天然带 focus ring。
          autoFocusConfirm: true,
        });
        if (ok) {
          navigate(`/settings?tab=${readiness.settingsTab}`);
        }
        return { proceed: false };
      }

      // device-link:远程草稿 / 远程会话 → 就绪态以**被控端**为准(控制端本机配置无关)。
      // 两条隧道查询并行:provider:list 提供与本地 / 手机同源的来源判定(唯一真相),
      // agent:status 提供 codex binary 轴 + 老被控端的 authReady 回退口径。
      // 任一查询失败不在控制端臆断(见 deriveRemoteReadiness 的 null 语义),
      // 全部失败放行交给被控端 create-session / send 做权威校验(host = 单一真相源)。
      const deviceId = options?.deviceId;
      if (deviceId) {
        const providerAgent: ProviderAgentKind =
          vendor === 'codex' ? 'codex' : vendor === 'pi' ? 'pi' : 'claude-code';
        const [statusRes, providersRes] = await Promise.allSettled([
          window.electronAPI.deviceLink.invoke(deviceId, 'maker:agent:status', [providerAgent]),
          window.electronAPI.deviceLink.invoke(deviceId, 'maker:provider:list', []),
        ]);
        const status =
          statusRes.status === 'fulfilled'
            ? (statusRes.value as { binaryReady: boolean; authReady: boolean })
            : null;
        const sourceReady =
          providersRes.status === 'fulfilled'
            ? sourceReadyFromProviderList(providersRes.value, providerAgent, {
                includeSuspended: options?.existingSessionRoute === true,
              })
            : null;
        const remoteReadiness = deriveRemoteReadiness(vendor, {
          binaryReady: status?.binaryReady ?? null,
          sourceReady,
          authReady: status?.authReady ?? null,
        });
        if (remoteReadiness === 'ready') return { proceed: true };
        // 未就绪:纯信息弹窗(控制端无法代被控端跳设置)。文案按「未就绪原因 + agent」细分,
        // 直接说清哪台设备缺什么、去那台设备的哪个设置页处理:
        //   codex 二进制缺失 → 组件未就绪;来源未就绪 → 该 agent 暂无已连接的模型来源
        //   (去「设置 → 模型供应商」;codex / cc 文案对称)。
        const device = remoteProjectsStore.getDeviceName(deviceId) ?? deviceId;
        let title: string;
        let description: string;
        if (remoteReadiness === 'binary-missing') {
          title = t(vendor === 'pi'
            ? 'logic.confirm.remotePiBinaryMissingTitle'
            : 'logic.confirm.remoteCodexBinaryMissingTitle');
          description = t('logic.confirm.remoteAuthDescription', { device });
        } else if (vendor === 'codex') {
          title = t('logic.confirm.remoteCodexNoSourceTitle');
          description = t('logic.confirm.remoteCodexNoSourceDescription', { device });
        } else {
          title = t('logic.confirm.remoteCcNoSourceTitle');
          description = t('logic.confirm.remoteCcNoSourceDescription', { device });
        }
        await confirm({
          title,
          description,
          confirmText: t('logic.confirm.gotIt'),
          showCancel: false,
          autoFocusConfirm: true,
        });
        return { proceed: false };
      }

      // 触发一次最新检查——避免 stale state 误放行。
      const target = vendor === 'codex' ? codex : vendor === 'pi' ? pi : cc;
      // 已建会话的发送门禁计入 suspended 来源(见 useVendorReadiness 注释);草稿不传。
      const readiness = await target.revalidate({
        includeSuspended: options?.existingSessionRoute === true,
      });
      const dialogCopy = pickCopy(copy, vendor, readiness);
      if (!dialogCopy) return { proceed: true };

      const ok = await confirm({
        title: dialogCopy.title,
        description: dialogCopy.description,
        confirmText: dialogCopy.confirmText,
        cancelText: dialogCopy.cancelText,
        // 主操作("前往设置")是非破坏性的,默认焦点交给它,
        // 否则 Radix 默认聚焦 Cancel,会让"取消"天然带 focus ring。
        autoFocusConfirm: true,
      });
      if (ok) {
        navigate(`/settings?tab=${dialogCopy.settingsTab}`);
      }
      return { proceed: false };
    },
    [cc, codex, pi, confirm, copy, navigate, t],
  );

  return { checkAndConfirm };
}
