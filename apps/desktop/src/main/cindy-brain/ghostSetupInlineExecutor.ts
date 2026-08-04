import type {
  GhostManifest,
  GhostSetupAllowedAction,
  GhostSetupAssessment,
} from '../../shared/ghost.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from '../../shared/ghost.js';
import type { GhostSetupActionResult } from './ghostSetupCoordinator.js';
import { t } from '../i18n.js';

export interface GhostSetupInlineExecutorDeps {
  getAssessment: (ghostId: string) => GhostSetupAssessment;
  getManifest: (ghostId: string) => GhostManifest | null;
  storeSecret: (ghostId: string, secretKey: string, value: string) => boolean;
  emitChange: (ghostId: string, secretKey: string) => void;
  onSaved?: (ghostId: string, label: string) => void;
  logger?: {
    warn: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Inline Secret 的最终写入闸。只从 fresh assessment item.ref 取得 storage
 * key；不信任 action/form 字段，也不把 value 放进返回、事件或日志。
 */
export function executeGhostSetupInlineSubmission(
  deps: GhostSetupInlineExecutorDeps,
  args: {
    ghostId: string;
    action: Extract<GhostSetupAllowedAction, { kind: 'inline_form' }>;
    value: string;
  },
): GhostSetupActionResult {
  const trimmed = args.value.trim();
  if (trimmed.length === 0 || trimmed.length > GHOST_SECRET_VALUE_MAX_CHARS) {
    return { ok: false, errorCode: 'INLINE_INVALID', message: t('newChat.pluginSetup.inlineSecretInvalid') };
  }

  const manifest = deps.getManifest(args.ghostId);
  if (!manifest) {
    return {
      ok: false,
      errorCode: 'TARGET_UNAVAILABLE',
      message: t('newChat.pluginSetup.pluginUnavailable'),
    };
  }

  const assessment = deps.getAssessment(args.ghostId);
  let boundRef: string | null = null;
  for (const group of assessment.groups) {
    if (group.items.some((item) => item.state === 'satisfied')) continue;
    for (const item of group.items) {
      if (
        item.state !== 'satisfied' &&
        item.actions.some(
          (action) => action.id === args.action.id && action.kind === 'inline_form',
        )
      ) {
        boundRef = item.ref;
        break;
      }
    }
    if (boundRef) break;
  }
  if (!boundRef?.startsWith('secret:')) {
    return {
      ok: false,
      errorCode: 'ACTION_STALE',
      message: t('newChat.pluginSetup.inlineActionExpired'),
    };
  }

  const secretKey = boundRef.slice('secret:'.length);
  const networkDecl = manifest.network?.secrets?.find(
    (secret) =>
      secret.key === secretKey &&
      secret.source !== 'oauth' &&
      secret.source !== 'login-email' &&
      secret.source !== 'oidc-token',
  );
  const nodeDecl = manifest.node?.secretBindings?.find((secret) => secret.key === secretKey);
  const decl = networkDecl ?? nodeDecl;
  if (!decl) {
    return {
      ok: false,
      errorCode: 'ACTION_STALE',
      message: t('newChat.pluginSetup.inlineSecretDeclChanged'),
    };
  }
  if (!deps.storeSecret(args.ghostId, secretKey, trimmed)) {
    return { ok: false, errorCode: 'SAVE_FAILED', message: t('newChat.pluginSetup.inlineSecretStoreFailed') };
  }
  deps.emitChange(args.ghostId, secretKey);
  try {
    deps.onSaved?.(args.ghostId, decl.label);
  } catch (error) {
    deps.logger?.warn('inline plugin setup notice failed', {
      ghostId: args.ghostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ok: true };
}
