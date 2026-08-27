/**
 * agentActionVerbKeys
 * ---------------------------------------------------------------------------
 * 工具动作人话动词的 i18n key 表。与桌面 `apps/desktop/src/shared/agentActionVerbKeys.ts`
 * 同名,供 mobile createMobileToolRowWording 解析 chat.agentActionRow.*。
 * 5 语言齐全性由 i18nCatalogParity.test.ts 兜底。
 */

import type { CommandIntentAction } from '@cindy/maker-shared';
import type { ToolRowVerbKey } from '@cindy/maker-shared/message-presentation';

/**
 * command intent(代码解析的命令意图,issue #450 codex 人话)→ 行级动词 key。
 * read / search / fetch 复用既有动词档,其余是本表新增 key。
 */
export const INTENT_ROW_VERB_KEY: Record<CommandIntentAction, string> = {
  read: 'chat.agentActionRow.verb.read',
  list: 'chat.agentActionRow.verb.listed',
  search: 'chat.agentActionRow.verb.searched',
  inspect: 'chat.agentActionRow.verb.inspect',
  inspectRepository: 'chat.agentActionRow.verb.inspectRepository',
  inspectEnvironment: 'chat.agentActionRow.verb.inspectEnvironment',
  modifyRepository: 'chat.agentActionRow.verb.modifyRepository',
  verify: 'chat.agentActionRow.verb.verify',
  fetch: 'chat.agentActionRow.verb.fetched',
  install: 'chat.agentActionRow.verb.installedDeps',
  test: 'chat.agentActionRow.verb.ranTests',
  build: 'chat.agentActionRow.verb.built',
  lint: 'chat.agentActionRow.verb.linted',
  typecheck: 'chat.agentActionRow.verb.typechecked',
  runScript: 'chat.agentActionRow.verb.runScript',
  runNodeScript: 'chat.agentActionRow.verb.runNodeScript',
  runPythonScript: 'chat.agentActionRow.verb.runPythonScript',
  runPerlScript: 'chat.agentActionRow.verb.runPerlScript',
  runSwiftScript: 'chat.agentActionRow.verb.runSwiftScript',
  checkSyntax: 'chat.agentActionRow.verb.checkSyntax',
  showVersion: 'chat.agentActionRow.verb.showVersion',
  checkFormatting: 'chat.agentActionRow.verb.checkFormatting',
  parseJson: 'chat.agentActionRow.verb.parseJson',
  count: 'chat.agentActionRow.verb.count',
  showCurrentDirectory: 'chat.agentActionRow.verb.showCurrentDirectory',
  showDateTime: 'chat.agentActionRow.verb.showDateTime',
  locateCommand: 'chat.agentActionRow.verb.locateCommand',
  inspectProcesses: 'chat.agentActionRow.verb.inspectProcesses',
  inspectPorts: 'chat.agentActionRow.verb.inspectPorts',
  queryDatabase: 'chat.agentActionRow.verb.queryDatabase',
  gitStatus: 'chat.agentActionRow.verb.gitStatus',
  gitDiff: 'chat.agentActionRow.verb.gitDiff',
  gitLog: 'chat.agentActionRow.verb.gitLog',
  gitShow: 'chat.agentActionRow.verb.gitShow',
  gitAdd: 'chat.agentActionRow.verb.gitAdd',
  gitCommit: 'chat.agentActionRow.verb.gitCommit',
  gitFetch: 'chat.agentActionRow.verb.gitFetch',
  gitPull: 'chat.agentActionRow.verb.gitPull',
  gitPush: 'chat.agentActionRow.verb.gitPush',
  gitRebase: 'chat.agentActionRow.verb.gitRebase',
  gitMerge: 'chat.agentActionRow.verb.gitMerge',
  gitCherryPick: 'chat.agentActionRow.verb.gitCherryPick',
  gitStash: 'chat.agentActionRow.verb.gitStash',
  gitRestore: 'chat.agentActionRow.verb.gitRestore',
  gitSubmodule: 'chat.agentActionRow.verb.gitSubmodule',
  gitRemote: 'chat.agentActionRow.verb.gitRemote',
  gitRevParse: 'chat.agentActionRow.verb.gitRevParse',
  gitBranch: 'chat.agentActionRow.verb.gitBranch',
  gitGrep: 'chat.agentActionRow.verb.gitGrep',
  gitMergeBase: 'chat.agentActionRow.verb.gitMergeBase',
  gitLsFiles: 'chat.agentActionRow.verb.gitLsFiles',
  gitRevList: 'chat.agentActionRow.verb.gitRevList',
  gitLsRemote: 'chat.agentActionRow.verb.gitLsRemote',
  gitWorktreeList: 'chat.agentActionRow.verb.gitWorktreeList',
  gitWorktreeAdd: 'chat.agentActionRow.verb.gitWorktreeAdd',
  gitWorktreeRemove: 'chat.agentActionRow.verb.gitWorktreeRemove',
  gitWorktreeMove: 'chat.agentActionRow.verb.gitWorktreeMove',
  gitWorktreePrune: 'chat.agentActionRow.verb.gitWorktreePrune',
  ghPrList: 'chat.agentActionRow.verb.ghPrList',
  ghPrView: 'chat.agentActionRow.verb.ghPrView',
  ghPrChecks: 'chat.agentActionRow.verb.ghPrChecks',
  ghPrStatus: 'chat.agentActionRow.verb.ghPrStatus',
  ghPrDiff: 'chat.agentActionRow.verb.ghPrDiff',
  ghPrCreate: 'chat.agentActionRow.verb.ghPrCreate',
  ghPrEdit: 'chat.agentActionRow.verb.ghPrEdit',
  ghPrComment: 'chat.agentActionRow.verb.ghPrComment',
  ghPrReview: 'chat.agentActionRow.verb.ghPrReview',
  ghPrMerge: 'chat.agentActionRow.verb.ghPrMerge',
  ghPrClose: 'chat.agentActionRow.verb.ghPrClose',
  ghPrReopen: 'chat.agentActionRow.verb.ghPrReopen',
  ghPrCheckout: 'chat.agentActionRow.verb.ghPrCheckout',
  ghIssueList: 'chat.agentActionRow.verb.ghIssueList',
  ghIssueView: 'chat.agentActionRow.verb.ghIssueView',
  ghIssueStatus: 'chat.agentActionRow.verb.ghIssueStatus',
  ghIssueCreate: 'chat.agentActionRow.verb.ghIssueCreate',
  ghIssueEdit: 'chat.agentActionRow.verb.ghIssueEdit',
  ghIssueComment: 'chat.agentActionRow.verb.ghIssueComment',
  ghIssueClose: 'chat.agentActionRow.verb.ghIssueClose',
  ghIssueReopen: 'chat.agentActionRow.verb.ghIssueReopen',
  ghAuthStatus: 'chat.agentActionRow.verb.ghAuthStatus',
  ghAuthLogin: 'chat.agentActionRow.verb.ghAuthLogin',
  ghAuthLogout: 'chat.agentActionRow.verb.ghAuthLogout',
  ghAuthRefresh: 'chat.agentActionRow.verb.ghAuthRefresh',
  ghAuthSwitch: 'chat.agentActionRow.verb.ghAuthSwitch',
  ghRunList: 'chat.agentActionRow.verb.ghRunList',
  ghRunView: 'chat.agentActionRow.verb.ghRunView',
  ghRunWatch: 'chat.agentActionRow.verb.ghRunWatch',
  ghSearch: 'chat.agentActionRow.verb.ghSearch',
  ghRepoList: 'chat.agentActionRow.verb.ghRepoList',
  ghRepoView: 'chat.agentActionRow.verb.ghRepoView',
  ghApiQuery: 'chat.agentActionRow.verb.ghApiQuery',
  ghApiMutation: 'chat.agentActionRow.verb.ghApiMutation',
  ghApiCall: 'chat.agentActionRow.verb.ghApiCall',
};

/**
 * 共享包 ToolRowWording 的 verb 槽 → i18n key(供 main 灵动岛构建本地化措辞)。
 * zh-CN 文案与 maker-shared 的 TOOL_ROW_VERB_ZH 默认表逐字一致。
 *
 * updateTodos 走 chat.agentActionRow.verb.updateTodos(桌面岛绑 agentIsland.native.updatingTasks,
 * 手机没有灵动岛 namespace,单独补这一档与 DEFAULT_TOOL_ROW_WORDING 对齐)。
 */
export const TOOL_ROW_VERB_I18N_KEY: Record<ToolRowVerbKey, string> = {
  read: 'chat.agentActionRow.verb.read',
  edit: 'chat.agentActionRow.verb.edited',
  create: 'chat.agentActionRow.verb.created',
  delete: 'chat.agentActionRow.fileChange.deleted',
  rename: 'chat.agentActionRow.fileChange.renamed',
  update: 'chat.agentActionRow.verb.updated',
  run: 'chat.agentActionRow.verb.ran',
  runCommand: 'chat.agentActionRow.verb.ranCommand',
  search: 'chat.agentActionRow.verb.searched',
  fetch: 'chat.agentActionRow.verb.fetched',
  use: 'chat.agentActionRow.verb.used',
  updateTodos: 'chat.agentActionRow.verb.updateTodos',
};

export const UPDATED_VERB_I18N_KEY = 'chat.agentActionRow.verb.updated';
export const FILE_CHANGE_FILES_I18N_KEY = 'chat.agentActionRow.fileChange.files';
/**
 * fileChange 多文件短语走**整句** key,不拼「动词 + 文件数」:日文语序是
 * 「N ファイルを更新」、韩文是「파일 N개 업데이트」,拼接出来的
 * 「更新 N ファイル」/「업데이트 파일 N개」都不成句。i18next 复数后缀由 count 选择。
 */
export const FILE_CHANGE_UPDATED_FILES_I18N_KEY = 'chat.agentActionRow.fileChange.updatedFiles';
