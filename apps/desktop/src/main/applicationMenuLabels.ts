/**
 * macOS 原生应用菜单的四语标签。
 *
 * 单独成模块是为了**能被术语门禁扫到**。它和 i18next 的 locale JSON 一样是用户可见
 * 文案,但不走 i18next,check-i18n-glossary.mjs 只读 locale JSON 扫不到它——引入术语表
 * 时这里就漏掉了「议题」(Issue 的禁用译法)和三处 ASCII 省略号,而这是 macOS 上一直
 * 挂在屏幕顶端的菜单栏。
 *
 * 覆盖它的是 __tests__/applicationMenuLabels.test.ts,与 mobile 影子 catalog 同一套路子:
 * vitest 直接 import 运行时对象,复用 scripts/shared/glossary-rules.mjs 的判定。
 * 之所以要抽出来,是因为原先它嵌在 bootstrap-electron.ts 里,测试一 import 就会拉起
 * 整个 Electron 主进程模块。
 */
import type { SupportedLocale } from '../shared/locale.js';

export type ApplicationMenuLocale = SupportedLocale;

export interface ApplicationMenuLabels {
  about: string;
  hide: string;
  quit: string;
  settings: string;
  checkForUpdates: string;
  fileMenu: string;
  newMaker: string;
  viewMenu: string;
  toggleSidebar: string;
  windowMenu: string;
  helpMenu: string;
  help: string;
  releaseNotes: string;
  issues: string;
}

export const APPLICATION_MENU_LABELS: Record<ApplicationMenuLocale, ApplicationMenuLabels> = {
  'zh-CN': {
    about: '关于 {{appName}}',
    hide: '隐藏 {{appName}}',
    quit: '退出 {{appName}}',
    settings: '设置…',
    checkForUpdates: '检查更新…',
    fileMenu: '文件',
    newMaker: '新建对话',
    viewMenu: '显示',
    toggleSidebar: '切换侧边栏',
    windowMenu: '窗口',
    helpMenu: '帮助',
    help: '帮助',
    releaseNotes: '最新更新介绍',
    issues: 'Issue',
  },
  en: {
    about: 'About {{appName}}',
    hide: 'Hide {{appName}}',
    quit: 'Quit {{appName}}',
    settings: 'Settings…',
    checkForUpdates: 'Check for Updates…',
    fileMenu: 'File',
    newMaker: 'New Chat',
    viewMenu: 'View',
    toggleSidebar: 'Toggle Sidebar',
    windowMenu: 'Window',
    helpMenu: 'Help',
    help: 'Help',
    releaseNotes: "What's New",
    issues: 'Issues',
  },
  ja: {
    about: '{{appName}} について',
    hide: '{{appName}}を隠す',
    quit: '{{appName}}を終了',
    settings: '設定…',
    checkForUpdates: 'アップデートを確認…',
    fileMenu: 'ファイル',
    newMaker: '新しい会話',
    viewMenu: '表示',
    toggleSidebar: 'サイドバーを切り替え',
    windowMenu: 'ウインドウ',
    helpMenu: 'ヘルプ',
    help: 'ヘルプ',
    releaseNotes: '最新情報',
    issues: 'Issue',
  },
  ko: {
    about: '{{appName}} 정보',
    hide: '{{appName}} 가리기',
    quit: '{{appName}} 종료',
    settings: '설정…',
    checkForUpdates: '업데이트 확인…',
    fileMenu: '파일',
    newMaker: '새 대화',
    viewMenu: '보기',
    toggleSidebar: '사이드바 토글',
    windowMenu: '윈도우',
    helpMenu: '도움말',
    help: '도움말',
    releaseNotes: '최신 업데이트',
    issues: '이슈',
  },
};
