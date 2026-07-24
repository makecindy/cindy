/**
 * agentActionsI18n.test.ts
 * ---------------------------------------------------------------------------
 * issue #450 — 工具调用摘要 / 行级动词 / 状态图标的 i18n key 在 4 语言全部
 * 存在的显式断言。
 *
 * 为什么需要:verbAggregator 通过映射表拼 key(`t(PART_KEY[verb])`),
 * i18nCompleteness.test.ts 的静态扫描认不出这种动态 key,漏翻会静默回退
 * 英文 — 本测试把这些 key 逐个钉死(参考 collaborationErrorI18n.test.ts
 * 范式)。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FILE_CHANGE_FILES_I18N_KEY,
  INTENT_ROW_VERB_KEY,
  TOOL_ROW_VERB_I18N_KEY,
  UPDATED_VERB_I18N_KEY,
} from '../../shared/agentActionVerbKeys';

const locales = ['zh-CN', 'en', 'ja', 'ko'] as const;

const VERBS = ['edited', 'created', 'ran', 'read', 'updated', 'searched', 'fetched', 'used'] as const;

/** command intent 专属动词档(verbLabelKeyForIntent 新增,无聚合 part.* 变体)。 */
const INTENT_VERBS = [
  'listed', 'inspect', 'inspectRepository', 'inspectEnvironment', 'modifyRepository', 'verify',
  'installedDeps', 'ranTests', 'built', 'linted', 'typechecked',
  'runScript', 'runNodeScript', 'runPythonScript', 'runPerlScript', 'runSwiftScript',
  'checkSyntax', 'showVersion', 'checkFormatting', 'parseJson', 'count',
  'showCurrentDirectory', 'showDateTime', 'locateCommand', 'inspectProcesses', 'inspectPorts',
  'queryDatabase',
  'gitStatus', 'gitDiff', 'gitLog', 'gitShow', 'gitAdd', 'gitCommit', 'gitFetch', 'gitPull', 'gitPush',
  'gitRebase', 'gitMerge', 'gitCherryPick', 'gitStash', 'gitRestore', 'gitSubmodule',
  'gitRemote', 'gitRevParse', 'gitBranch', 'gitGrep', 'gitMergeBase', 'gitLsFiles', 'gitRevList',
  'gitLsRemote',
  'gitWorktreeList', 'gitWorktreeAdd', 'gitWorktreeRemove', 'gitWorktreeMove', 'gitWorktreePrune',
  'ghPrList', 'ghPrView', 'ghPrChecks', 'ghPrStatus', 'ghPrDiff', 'ghPrCreate', 'ghPrEdit',
  'ghPrComment', 'ghPrReview', 'ghPrMerge', 'ghPrClose', 'ghPrReopen', 'ghPrCheckout',
  'ghIssueList', 'ghIssueView', 'ghIssueStatus', 'ghIssueCreate', 'ghIssueEdit', 'ghIssueComment',
  'ghIssueClose', 'ghIssueReopen',
  'ghAuthStatus', 'ghAuthLogin', 'ghAuthLogout', 'ghAuthRefresh', 'ghAuthSwitch',
  'ghRunList', 'ghRunView', 'ghRunWatch', 'ghSearch', 'ghRepoList', 'ghRepoView',
  'ghApiQuery', 'ghApiMutation', 'ghApiCall',
] as const;

const COMMAND_FALLBACK_VERBS = ['ranCommand'] as const;

function readLocale(locale: (typeof locales)[number]) {
  return JSON.parse(
    readFileSync(resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'), 'utf8'),
  ) as {
    chat?: {
      agentActionRow?: {
        fileChange?: Record<string, unknown>;
        verb?: Record<string, unknown>;
        status?: Record<string, unknown>;
      };
      agentActions?: Record<string, unknown> & { part?: Record<string, unknown> };
    };
  };
}

describe('agent actions i18n', () => {
  it('keeps row verb labels and status labels translated in every supported locale', () => {
    for (const locale of locales) {
      const row = readLocale(locale).chat?.agentActionRow;
      for (const verb of [...VERBS, ...INTENT_VERBS, ...COMMAND_FALLBACK_VERBS]) {
        expect(row?.verb?.[verb], `${locale} chat.agentActionRow.verb.${verb}`).toEqual(
          expect.any(String),
        );
      }
      expect(row?.status?.running, `${locale} status.running`).toEqual(expect.any(String));
      expect(row?.status?.done, `${locale} status.done`).toEqual(expect.any(String));
      for (const key of ['deleted', 'renamed', 'files', 'rawData']) {
        expect(row?.fileChange?.[key], `${locale} fileChange.${key}`).toEqual(expect.any(String));
      }
    }
  });

  it('resolves every shared verb-key table entry in every supported locale', () => {
    // 灵动岛(main 侧 t())与面板共用 src/shared/agentActionVerbKeys.ts;
    // 表里的 key 是自由字符串,防手滑指向不存在的 key。
    const lookup = (bundle: Record<string, unknown>, key: string): unknown => {
      let cur: unknown = bundle;
      for (const part of key.split('.')) {
        if (typeof cur !== 'object' || cur === null) return undefined;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    };
    const allKeys = [
      ...Object.values(INTENT_ROW_VERB_KEY),
      ...Object.values(TOOL_ROW_VERB_I18N_KEY),
      UPDATED_VERB_I18N_KEY,
      FILE_CHANGE_FILES_I18N_KEY,
    ];
    for (const locale of locales) {
      const bundle = readLocale(locale) as Record<string, unknown>;
      for (const key of allKeys) {
        expect(lookup(bundle, key), `${locale} ${key}`).toEqual(expect.any(String));
      }
    }
  });

  it('keeps aggregate summary phrases translated in every supported locale', () => {
    for (const locale of locales) {
      const actions = readLocale(locale).chat?.agentActions;
      // 复数家族:en 需要 _one + _other,CJK(Intl.PluralRules 只有 other)只需
      // _other — 与 check-i18n 的家族校验口径一致。
      for (const verb of VERBS) {
        expect(actions?.part?.[`${verb}_other`], `${locale} part.${verb}_other`).toEqual(
          expect.any(String),
        );
        if (locale === 'en') {
          expect(actions?.part?.[`${verb}_one`], `en part.${verb}_one`).toEqual(expect.any(String));
        }
      }
      expect(actions?.more_other, `${locale} more_other`).toEqual(expect.any(String));
      if (locale === 'en') {
        expect(actions?.more_one, 'en more_one').toEqual(expect.any(String));
      }
      expect(actions?.separator, `${locale} separator`).toEqual(expect.any(String));
      expect(actions?.lastSeparator, `${locale} lastSeparator`).toEqual(expect.any(String));
    }
  });
});
