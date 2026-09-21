import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { brandUserDataDirName } from '@cindy/maker-shared/brand-identity';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { shouldSuppressLocalCodexAuth } from './codex-auth-invalidation.js';

/** 本机 Codex CLI 默认维护的 OpenAI 登录态。 */
export function getCodexCliAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

/** 当前区域 Release 维护的 OpenAI 登录态。 */
export function getReleaseCodexAuthPath(): string {
  return path.join(
    app.getPath('appData'),
    brandUserDataDirName(CURRENT_CINDY_REGION),
    'codex-home',
    'auth.json',
  );
}

function releaseOpenAiConnectionOwner(): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(
          path.dirname(path.dirname(getReleaseCodexAuthPath())),
          'native-provider-auth.json',
        ),
        'utf8',
      ),
    ) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const bindings = raw as { openai?: unknown; revoked?: unknown };
    if (
      bindings.revoked !== undefined &&
      (!bindings.revoked || typeof bindings.revoked !== 'object' || Array.isArray(bindings.revoked))
    ) {
      return null;
    }
    if (bindings.revoked && Object.prototype.hasOwnProperty.call(bindings.revoked, 'openai')) {
      return null;
    }
    return typeof bindings.openai === 'string' && bindings.openai.trim().length > 0
      ? bindings.openai.trim()
      : null;
  } catch {
    return null;
  }
}

function hasUsableCodexOAuth(pathname: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, 'utf8')) as {
      tokens?: { access_token?: unknown };
    };
    return (
      typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * 普通 Dev 只读复用同 owner、同区域 Release 的登录态；Release 不可用时沿用
 * 原有的本机 Codex 共享来源。Packaged 行为保持不变，仍只与本机 Codex 协调。
 */
export function getPreferredSharedCodexAuthPath(activeOwnerId: string | null): string {
  if (!app.isPackaged) {
    const releaseAuth = getReleaseCodexAuthPath();
    const releaseUserData = path.dirname(path.dirname(releaseAuth));
    // Shared Dev runs directly against the Release profile. Never fall back to
    // ~/.codex here: reconcile would otherwise replace Release auth.json and
    // claim its binding, violating the read-only Dev boundary. An unbound or
    // mismatched Release credential stays in place and fails closed later.
    if (path.resolve(app.getPath('userData')) === path.resolve(releaseUserData)) {
      return releaseAuth;
    }
    const releaseOwner = releaseOpenAiConnectionOwner();
    if (
      hasUsableCodexOAuth(releaseAuth) &&
      !shouldSuppressLocalCodexAuth(path.dirname(releaseAuth), releaseAuth) &&
      activeOwnerId !== null &&
      activeOwnerId === releaseOwner
    ) {
      return releaseAuth;
    }
  }
  return getCodexCliAuthPath();
}
