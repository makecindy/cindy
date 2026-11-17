import type { Maker } from '@cindy/maker-core';
import { createVisionBridge } from '../../../desktop/src/main/vision-bridge/visionBridgeCore.js';
import { createVisionBridgeSettingsStore } from '../../../desktop/src/main/vision-bridge/visionBridgeSettingsStoreCore.js';
import { buildPiVisionBridgeEnv } from '../../../desktop/src/main/vision-bridge/piVisionBridgeEnvCore.js';
import {
  getVisionBridgeController,
  setVisionBridgeController,
  type VisionBridgeController,
} from '../../../desktop/src/main/vision-bridge/vision-bridge-controller.js';
import { resolveVisionBackendRoute, setVisionGatewayKeyReader } from '../../../desktop/src/main/maker-host/provider-route.js';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
import { getSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.js';
import { effectiveXdGatewayBaseUrl } from '../../../desktop/src/main/model-access/effectiveEndpoint.js';
import type { VisionChannelDeps } from '../../../desktop/src/main/vision-bridge/vision-channel.js';
import { hostOutbound } from '../outbound.mjs';

type Logger = ReturnType<typeof import('../../../desktop/src/main/maker-host/logger-adapter.js').createMakerLogger>;

/** A vision-bridge notice as the desktop sends it to its windows (MAKER_PUSH.EVENT). */
export interface VisionBridgeNotice {
  sessionId: string;
  event: {
    type: 'error';
    data: { message: string; isTerminal: false; reason: string; imageCount?: number };
    source: 'vision-bridge';
  };
}

/**
 * The desktop's vision-bridge notices (maker-host/index.ts broadcastVisionBridgeEvent): the same
 * dedup and text, sent through the Host's event hub instead of to the desktop windows; the
 * client maps them to MAKER_PUSH.EVENT (device-link.ts). The dedup state is per runtime.
 */
export function createVisionBridgeNotices(publish: (notice: VisionBridgeNotice) => void, logger: Logger) {
  const VISION_BRIDGE_DEDUP_MS = 2_000;
  const _visionBridgeDedup = new Map<string, number>();
  return function broadcastVisionBridgeEvent(
    sessionId: string,
    reason: 'vision-bridge-recognizing' | 'vision-bridge-fallback' | 'vision-bridge-unavailable',
    extra: { imageCount?: number } = {},
  ): void {
    if (reason === 'vision-bridge-recognizing') {
      for (const key of _visionBridgeDedup.keys()) {
        if (key.startsWith(`${sessionId}|`)) _visionBridgeDedup.delete(key);
      }
    } else {
      const key = `${sessionId}|${reason}`;
      const now = Date.now();
      const last = _visionBridgeDedup.get(key);
      if (last !== undefined && now - last < VISION_BRIDGE_DEDUP_MS) return;
      _visionBridgeDedup.set(key, now);
    }

    const message = reason === 'vision-bridge-recognizing'
      ? '正在识别图片中…'
      : reason === 'vision-bridge-fallback'
        ? '视觉桥使用了备用视觉后端（主后端不可用）'
        : '视觉桥当前不可用，图片无法转成文字描述，已以文字提示代替';
    const payload = {
      sessionId,
      event: {
        type: 'error' as const,
        data: {
          message,
          isTerminal: false,
          reason,
          ...(extra.imageCount !== undefined ? { imageCount: extra.imageCount } : {}),
        },
        source: 'vision-bridge',
      },
    };
    try {
      publish(payload as VisionBridgeNotice);
    } catch (error) {
      logger.child('vision-bridge').warn('vision bridge event broadcast failed', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

/**
 * The desktop's vision bridge (maker-host/index.ts), for one Host runtime: the profile's own
 * vision-bridge-settings.json (never written or deleted by the Host, boot-settings.ts), the
 * Maker hook (layer B), the Pi env (layer C) and the process-wide controller the loopback
 * proxies (layer A) and the Pi env read. Ports as the desktop's: the active catalog, the task's
 * provider, the custom provider keys, the account gateway key and endpoint, the Host's outbound
 * fetch. The process-wide gateway key reader and controller are this runtime's until it closes;
 * after that the reader returns nothing and the controller is cleared unless a newer runtime has
 * already set its own.
 */
export function createHostVisionBridge(options: {
  userDataDir: string;
  getMaker: () => Pick<Maker, 'getSession'> | null;
  readCustomProviderKey: VisionChannelDeps['readCustomProviderKey'];
  readGatewayKey: () => string | null;
  publish: (notice: VisionBridgeNotice) => void;
  logger: Logger;
}) {
  let closed = false;
  const settings = createVisionBridgeSettingsStore({ app: { getPath: () => options.userDataDir } });
  const readGatewayKey = () => (closed ? null : options.readGatewayKey());
  const broadcastVisionBridgeEvent = createVisionBridgeNotices(options.publish, options.logger);
  const getProviderById = (providerId: string) =>
    getActiveCatalog().providers.find((provider) => provider.id === providerId) ?? null;
  setVisionGatewayKeyReader(readGatewayKey);
  const instance = createVisionBridge({
    getProviderById,
    resolveTargetModel: (modelId, sessionId) => {
      const session = options.getMaker()?.getSession(sessionId);
      const providerId = getSessionProvider(sessionId);
      if (!session || !providerId) return null;
      const provider = getActiveCatalog().providers.find((entry) => entry.id === providerId);
      return provider?.models[session.agentKind]?.find((model) => model.id === modelId) ?? null;
    },
    readCustomProviderKey: options.readCustomProviderKey,
    readGatewayKey,
    resolveGatewayEndpoint: () => effectiveXdGatewayBaseUrl() || null,
    resolveBackendRoute: (providerId, modelId) =>
      resolveVisionBackendRoute(providerId, modelId, effectiveXdGatewayBaseUrl() || null),
    fetch: hostOutbound.outboundFetch,
    logger: options.logger.child('vision-bridge'),
    onStart: (sessionId, imageCount) => {
      broadcastVisionBridgeEvent(sessionId, 'vision-bridge-recognizing', { imageCount });
    },
    onNote: (_note, sessionId, kind) => {
      broadcastVisionBridgeEvent(
        sessionId,
        kind === 'fallback' ? 'vision-bridge-fallback' : 'vision-bridge-unavailable',
      );
    },
  }, settings);
  const controller: VisionBridgeController = {
    shouldBridge: instance.isTargetModel,
    describeImage: instance.describeImage,
  };
  return {
    hook: instance.hook,
    settings,
    /** Maker's resolvePiVisionBridgeEnv, as the desktop's (maker-host/index.ts). */
    resolvePiVisionBridgeEnv: (model: string, sessionId?: string) =>
      buildPiVisionBridgeEnv(
        {
          getProviderById,
          readCustomProviderKey: options.readCustomProviderKey,
          readGatewayKey,
          resolveBackendRoute: (providerId, modelId) =>
            resolveVisionBackendRoute(providerId, modelId, effectiveXdGatewayBaseUrl() || null),
          fetch: hostOutbound.outboundFetch,
        },
        model,
        sessionId,
        settings,
      ),
    /** The desktop sets the controller once Maker and its agents exist. */
    activate() {
      if (!closed) setVisionBridgeController(controller);
    },
    close() {
      closed = true;
      if (getVisionBridgeController() === controller) setVisionBridgeController(null);
      instance.dispose();
    },
  };
}
