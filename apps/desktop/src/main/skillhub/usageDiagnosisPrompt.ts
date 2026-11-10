import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/locale';
import type { SkillUsageRefreshStatus } from '../../shared/skillUsageRefresh';
import en from '../../renderer/i18n/locales/en/common.json';
import zhCN from '../../renderer/i18n/locales/zh-CN/common.json';
import zhTW from '../../renderer/i18n/locales/zh-TW/common.json';
import ja from '../../renderer/i18n/locales/ja/common.json';
import ko from '../../renderer/i18n/locales/ko/common.json';
import es from '../../renderer/i18n/locales/es/common.json';
import fr from '../../renderer/i18n/locales/fr/common.json';
import de from '../../renderer/i18n/locales/de/common.json';
import ptPT from '../../renderer/i18n/locales/pt-PT/common.json';
import ptBR from '../../renderer/i18n/locales/pt-BR/common.json';
import { RECENT_USAGE_WINDOW_DAYS } from './usageWindow';

const promptResources = {
  en: en.skillhub.detail.usageDiagnosisPrompt,
  'zh-CN': zhCN.skillhub.detail.usageDiagnosisPrompt,
  'zh-TW': zhTW.skillhub.detail.usageDiagnosisPrompt,
  ja: ja.skillhub.detail.usageDiagnosisPrompt,
  ko: ko.skillhub.detail.usageDiagnosisPrompt,
  es: es.skillhub.detail.usageDiagnosisPrompt,
  fr: fr.skillhub.detail.usageDiagnosisPrompt,
  de: de.skillhub.detail.usageDiagnosisPrompt,
  'pt-PT': ptPT.skillhub.detail.usageDiagnosisPrompt,
  'pt-BR': ptBR.skillhub.detail.usageDiagnosisPrompt,
  'zh-Hans-x-lzh': zhCN.skillhub.detail.usageDiagnosisPrompt,
  'zh-Hant-x-lzh': zhTW.skillhub.detail.usageDiagnosisPrompt,
} satisfies Record<SupportedLocale, typeof en.skillhub.detail.usageDiagnosisPrompt>;

/** 只生成用户可检查的草稿; 原始对话内容由诊断 Agent 按索引读取。 */
export function renderSkillUsageDiagnosisPrompt(params: {
  skillName: string;
  skillPath: string | null;
  stats: Record<string, unknown>;
  evidenceIndexes: Array<Record<string, unknown>>;
  locale?: SupportedLocale;
  refreshStatus?: SkillUsageRefreshStatus;
}): string {
  const text = promptResources[params.locale ?? DEFAULT_LOCALE];
  return [
    text.request.replaceAll('{{skillName}}', () => params.skillName),
    '',
    text.boundaries.replaceAll('{{days}}', String(RECENT_USAGE_WINDOW_DAYS)),
    '',
    text.skillHeading,
    JSON.stringify({ name: params.skillName, skillPath: params.skillPath }, null, 2),
    '',
    text.statsHeading,
    JSON.stringify(params.stats, null, 2),
    ...(params.refreshStatus ? [
      '',
      text.freshnessHeading,
      text.freshnessBoundary,
      JSON.stringify({
        refreshing: params.refreshStatus.phase === 'discovering' || params.refreshStatus.phase === 'indexing',
        incomplete: params.refreshStatus.phase !== 'complete' || params.refreshStatus.incomplete,
        lastSuccessfulRefresh: params.refreshStatus.lastSuccessAt
          ? new Date(params.refreshStatus.lastSuccessAt).toISOString() : null,
        missingTranscriptCount: params.refreshStatus.missingCount,
      }, null, 2),
    ] : []),
    '',
    text.evidenceHeading,
    JSON.stringify(params.evidenceIndexes, null, 2),
    '',
    text.report,
  ].join('\n');
}
