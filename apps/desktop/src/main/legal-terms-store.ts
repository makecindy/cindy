/**
 * legal-terms-store —— 本机最近一次同意的《服务条款》《隐私协议》版本。
 *
 * File: <userData>/legal-terms-consent.json
 *
 * 与 analytics-settings.json 的 privacyConsentAccepted 是两件事:那个字段回答「有没有同意过
 * 隐私政策」(采集的前置条件),本文件回答「同意的是哪一版」。协议更新后,已同意过旧版的
 * 个人账号要重新确认一次,判据是 `privacyConsentAccepted && acceptedVersion !== 当前版本`
 * (见 analyticsSettingsService 的 legalTermsUpdateRequired)。
 *
 * 写入时机只有两个,都是用户的明示同意:登录页协议门放行(新用户 / 重新登录),以及主界面
 * 的协议更新确认弹窗点「同意」。存量同意迁移不写本文件——那批用户只同意过旧版,正是需要
 * 重新确认的人。
 */

import { app } from 'electron';
import path from 'node:path';

import { LEGAL_TERMS_VERSION } from '../shared/legalTermsVersion';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('legal-terms-store');

export interface LegalTermsConsent {
  /** 本机最近一次明示同意的协议版本;null = 从未在带版本记录的客户端上同意过。 */
  acceptedVersion: string | null;
}

const DEFAULTS: LegalTermsConsent = { acceptedVersion: null };

const store = createOverrideSettingsFile<LegalTermsConsent>({
  filePath: () => path.join(app.getPath('userData'), 'legal-terms-consent.json'),
  defaults: DEFAULTS,
  normalize: (raw) => {
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    const value = (raw as Record<string, unknown>).acceptedVersion;
    return {
      acceptedVersion: typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null,
    };
  },
  log,
  label: 'legal-terms',
  maxBytes: 4096,
});

export function readAcceptedLegalTermsVersion(): string | null {
  return store.read().acceptedVersion;
}

/** 记录用户已同意当前版本协议。幂等。 */
export function acceptCurrentLegalTerms(): void {
  if (store.read().acceptedVersion === LEGAL_TERMS_VERSION) return;
  store.writePatch({ acceptedVersion: LEGAL_TERMS_VERSION });
  log.info('legal terms accepted', { version: LEGAL_TERMS_VERSION });
}
