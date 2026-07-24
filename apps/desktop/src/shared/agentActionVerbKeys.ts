/**
 * agentActionVerbKeys
 * ---------------------------------------------------------------------------
 * 工具动作人话动词的 i18n key 表(纯数据,main / renderer 共享)。
 *
 * renderer 面板(AgentActionRow 经 verbAggregator)与 main 灵动岛
 * (agent-island/toolWording)各自用自己的 t() 解析同一批 key,让两端的
 * "正在做什么"措辞来自同一事实源。key 的 4 语言齐全性由
 * `renderer/__tests__/agentActionsI18n.test.ts` 显式断言兜底
 * (i18nCompleteness 静态扫描认不出 `t(变量)`)。
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
 * updateTodos 特例:绑到灵动岛既有的 `agentIsland.native.updatingTasks`
 * ("正在更新任务",进行时)——岛是实况状态面,面板没有"更新待办"的 i18n key,
 * 复用现成 4 语言 key 而不新增。
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
  updateTodos: 'agentIsland.native.updatingTasks',
};

/** fileChange 多文件短语的组成 key:`${t(UPDATED_VERB)} ${t(FILES).replace('{{count}}', n)}`。 */
export const UPDATED_VERB_I18N_KEY = 'chat.agentActionRow.verb.updated';
export const FILE_CHANGE_FILES_I18N_KEY = 'chat.agentActionRow.fileChange.files';
