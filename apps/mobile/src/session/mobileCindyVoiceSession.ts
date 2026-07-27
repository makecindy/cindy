import Constants from 'expo-constants';

import { ApiError, type ApiFetchOptions } from '@/api/client';
import {
  AUTH_REGION,
  VOICE_API_BASE_URL,
  type CindyAuthRegion,
} from '@/config/env';
import { i18n } from '@/i18n';
import type {
  MobileVoiceCredentialSyncAsr,
  MobileVoiceCredentialSyncRefiner,
} from '@cindy/maker-shared/device-link-contract';
import {
  assertMobileVoiceCredentialShape,
  type StoredMobileVoiceCredential,
} from '@/session/mobileVoiceCredentialStore';
import { resolveMobileVoiceAsrLanguage } from '@/session/mobileVoiceLanguage';

const VOICE_SESSION_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_REFINE_WARMUP_TIMEOUT_MS = 10_000;

/**
 * 润色模型选择与 failover 交给 voice-server:会话用这个标记创建,refine 目标也
 * 携带它作为 provider,服务端跑自己配置的模型链(与 desktop
 * CindyVoiceSessionClient 的 CINDY_MANAGED_REFINER_PROVIDER 同构)。
 */
export const CINDY_MANAGED_REFINER_PROVIDER = 'auto';

type AccessTokenProvider = () => Promise<string | null>;
type AuthenticatedApiFetch = <T>(
  path: string,
  options: Omit<ApiFetchOptions, 'token'>,
) => Promise<T>;

type VoiceSessionResponse = {
  sessionId: string;
  ticket: string;
  expiresAt: string;
  asr: {
    provider: string;
    websocketUrl: string;
    protocolProfile: string;
    sampleRate: number;
  };
};

/** Per-dictation holder for one-shot ASR tickets and the owning refine session. */
export class MobileCindyVoiceRunContext {
  private latestSessionId: string | null = null;
  private readonly sourceLanguage: string | undefined;
  /**
   * 旧 voice-server 不认识 'auto' 标记时置位:会话分配已降级为无润色,后续
   * refine/warmup 直接快速失败(原始 ASR 文本保留),听写本身不受影响。
   */
  private refinerUnavailableOnServer = false;

  constructor(
    private readonly getAccessToken: AccessTokenProvider,
    private readonly refreshAccessToken: AccessTokenProvider,
    private readonly apiFetch: AuthenticatedApiFetch,
    sourceLanguage: string | undefined,
    private readonly refinerProvider: string | undefined,
  ) {
    this.sourceLanguage = resolveMobileVoiceAsrLanguage(sourceLanguage);
  }

  async createAsrConnection(asrProvider: string): Promise<{
    websocketUrl: string;
    authorizationToken: string;
  }> {
    let session: VoiceSessionResponse;
    try {
      session = await this.createVoiceSession(
        asrProvider,
        this.refinerUnavailableOnServer ? undefined : this.refinerProvider,
      );
    } catch (error) {
      // 未部署 'auto' 契约的旧 voice-server 会 400 拒掉整个会话——那会连听写一起
      // 杀掉,不只是润色。去掉 refinerProvider 重试一次,让 ASR 仍然可用。收窄到
      // 参数校验类 400(旧服务端拒绝 auto 的实际错误码是 INVALID_PARAMS),避免
      // 其它形态的 400 误入降级路径;降级标记仍只在无润色重试成功后置位——重试
      // 成功本身就证明 400 由 'auto' 标记引起。
      const legacyServerRejection = this.refinerProvider === CINDY_MANAGED_REFINER_PROVIDER
        && !this.refinerUnavailableOnServer
        && error instanceof ApiError
        && error.status === 400
        && error.code === 'INVALID_PARAMS';
      if (!legacyServerRejection) throw error;
      // 只有无润色重试**成功**后才置位:如果 400 其实是这个 ASR 候选自身的问题
      // (与 'auto' 无关),重试同样失败,同一 run context 上的下一个 ASR 候选
      // 仍要尝试托管润色。
      session = await this.createVoiceSession(asrProvider, undefined);
      this.refinerUnavailableOnServer = true;
    }
    this.latestSessionId = session.sessionId;
    return { websocketUrl: session.asr.websocketUrl, authorizationToken: session.ticket };
  }

  private async createVoiceSession(
    asrProvider: string,
    refinerProvider: string | undefined,
  ): Promise<VoiceSessionResponse> {
    const session = await this.apiFetch<VoiceSessionResponse>('/api/voice/sessions', {
      baseUrl: requireVoiceBaseUrl(),
      method: 'POST',
      body: {
        mode: 'dictation',
        language: this.sourceLanguage,
        client: 'mobile',
        clientVersion: Constants.nativeAppVersion ?? Constants.expoConfig?.version,
        asrProvider,
        refinerProvider,
      },
      timeoutMs: VOICE_SESSION_REQUEST_TIMEOUT_MS,
    });
    if (
      !session.sessionId
      || !session.ticket
      || session.asr?.provider !== asrProvider
      || !/^wss?:\/\//.test(session.asr.websocketUrl)
    ) {
      throw new Error(i18n.t('composer.voice.invalidSession'));
    }
    return session;
  }

  async createRefinerTarget(refinerProvider: string, options?: { refreshAccessToken?: boolean }): Promise<{
    url: string;
    authorization: string;
  }> {
    if (this.refinerUnavailableOnServer) {
      throw new Error(i18n.t('composer.voice.managedRefineUnsupported'));
    }
    if (!this.latestSessionId) throw new Error(i18n.t('composer.voice.sessionNotConnected'));
    const token = await this.requireAccessToken(options?.refreshAccessToken);
    return {
      url: `${requireVoiceBaseUrl()}/api/voice/sessions/${encodeURIComponent(this.latestSessionId)}/refine?provider=${encodeURIComponent(refinerProvider)}`,
      authorization: `Bearer ${token}`,
    };
  }

  /**
   * Fire-and-forget 的润色 prompt cache 预热:ASR 会话建立后立刻发一个与真实
   * 润色请求共享 prompt 前缀(dictationText 为空)的请求,让上游缓存在用户停止
   * 说话前就热起来。调用方吞掉失败——预热绝不能影响听写主流程。
   */
  async warmRefiner(input: {
    system: string;
    user: unknown;
    promptCacheKey: string;
  }): Promise<void> {
    if (this.refinerUnavailableOnServer) {
      throw new Error(i18n.t('composer.voice.managedRefineUnsupported'));
    }
    const sessionId = this.latestSessionId;
    if (!sessionId) throw new Error(i18n.t('composer.voice.sessionNotConnected'));
    // 非 2xx 由 apiFetch 抛 ApiError;超时同样抛错,由调用方仅记录。
    await this.apiFetch(
      `/api/voice/sessions/${encodeURIComponent(sessionId)}/refine-warmup`,
      {
        baseUrl: requireVoiceBaseUrl(),
        method: 'POST',
        body: {
          prompt_cache_key: input.promptCacheKey,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: JSON.stringify(input.user) },
          ],
        },
        timeoutMs: VOICE_REFINE_WARMUP_TIMEOUT_MS,
      },
    );
  }

  private async requireAccessToken(refreshAccessToken = false): Promise<string> {
    const token = await (refreshAccessToken ? this.refreshAccessToken : this.getAccessToken)();
    if (!token) throw new Error(i18n.t('composer.voice.loginRequired'));
    return token;
  }
}

const MANAGED_CREDENTIAL_STORAGE_VERSION = 1;
/** 占位串:托管路径不落任何推理 key,ASR/refine 鉴权走 voice-server 一次性票据。 */
const MANAGED_CREDENTIAL_PLACEHOLDER_KEY = 'cindy-voice-session-ticket';

/**
 * 托管 ASR 候选链:provider 名传给 /api/voice/sessions 换一次性票据,真实连接
 * 参数(websocketUrl 等)由服务端回填。整链固定 16 kHz:麦克风按主 provider 的
 * 采样率打开一次,fallback 时活跃 provider 向服务端申报自己的 pcmSampleRate,
 * 24 kHz 申报叠 16 kHz PCM 会失真;Whisper 内部本来就重采样到 16 kHz,整链
 * 16 kHz 是安全的。
 */
const CINDY_MANAGED_ASR_CHAIN = [
  {
    provider: 'litellm-volcengine-sauc-asr',
    model: 'volcengine-sauc-asr',
    auth: 'api-key',
    mode: 'provider-native-websocket',
    endpointPath: '/volcengine/api/v3/sauc/bigmodel_async',
    pcmSampleRate: 16_000,
    protocolProfile: 'volcengine-sauc-duration',
    resourceId: 'volc.seedasr.sauc.duration',
  },
  {
    provider: 'litellm-qwen3-asr-flash-realtime',
    model: 'qwen3-asr-flash-realtime',
    auth: 'api-key',
    mode: 'realtime-websocket',
    endpointPath: '/dashscope/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    pcmSampleRate: 16_000,
    protocolProfile: 'qwen-asr-server-vad',
  },
  {
    provider: 'litellm-gpt-realtime-whisper',
    model: 'gpt-realtime-whisper',
    auth: 'api-key',
    mode: 'realtime-websocket',
    endpointPath: '/openai/passthrough/v1/realtime?intent=transcription',
    litellmHeaderModel: 'gpt-realtime-whisper',
    pcmSampleRate: 16_000,
    protocolProfile: 'openai-transcription-manual',
  },
] as const satisfies readonly MobileVoiceCredentialSyncAsr[];

/** 托管润色单链:模型选择与 failover 全部在 voice-server,客户端只带 'auto' 标记。 */
const CINDY_MANAGED_REFINER_CHAIN = [
  {
    provider: CINDY_MANAGED_REFINER_PROVIDER,
    model: CINDY_MANAGED_REFINER_PROVIDER,
    auth: 'api-key',
    transport: 'litellm-chat-completions',
    endpointPath: '/v1/chat/completions',
  },
] as const satisfies readonly MobileVoiceCredentialSyncRefiner[];

/** Builds the provider-neutral profile graph without persisting any inference key. */
export function createMobileCindyVoiceCredential(
  hostDeviceId: string,
  region: CindyAuthRegion = AUTH_REGION,
): StoredMobileVoiceCredential {
  const normalizedHostDeviceId = hostDeviceId.trim();
  if (!normalizedHostDeviceId) throw new Error('host device id is required');
  const baseUrl = requireVoiceBaseUrl();
  const issuedAt = new Date().toISOString();
  const credential: StoredMobileVoiceCredential = {
    temporary: true,
    credentialVersion: 1,
    issuedAt,
    proxyBaseUrl: baseUrl,
    proxyApiKey: MANAGED_CREDENTIAL_PLACEHOLDER_KEY,
    asr: { ...CINDY_MANAGED_ASR_CHAIN[0] },
    asrProviderChain: CINDY_MANAGED_ASR_CHAIN.map((item) => ({ ...item })),
    refiner: { ...CINDY_MANAGED_REFINER_CHAIN[0] },
    refinerProviderChain: CINDY_MANAGED_REFINER_CHAIN.map((item) => ({ ...item })),
    settings: {
      // Global and dev builds let ASR detect the spoken language. The Mainland
      // China build keeps Chinese as its product default.
      language: region === 'cn' ? 'zh-CN' : 'auto',
      refinementEnabled: true,
      playInteractionSound: true,
    },
    hostDeviceId: normalizedHostDeviceId,
    storageVersion: MANAGED_CREDENTIAL_STORAGE_VERSION,
    syncedAt: issuedAt,
  };
  assertMobileVoiceCredentialShape(credential);
  return credential;
}

function requireVoiceBaseUrl(): string {
  if (!VOICE_API_BASE_URL) throw new Error(i18n.t('composer.voice.serviceUnavailable'));
  return VOICE_API_BASE_URL.replace(/\/+$/, '');
}
