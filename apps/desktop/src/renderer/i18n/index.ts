/**
 * i18n 入口 —— 同步 init i18next，导出常量与类型。
 *
 * 设计要点：
 * - 资源同步 import (零网络/零 IO)，i18n.init 同步完成 → React 首屏不闪。
 * - 默认 namespace 为 'common'；体积较小、边界清晰的功能文案可独立拆分。
 * - fallbackLng：缺 key 时不显示 key 本身,直接回退英文。
 * - 不接 LanguageDetector backend，初始化与 useLocale 共用现有语言偏好。
 *   'system' 的实际语言由 main 侧读取 OS 首选语言后传入 renderer。
 */

import esCommon from './locales/es/common.json';
import esAiRename from './locales/es/aiRename.json';
import frCommon from './locales/fr/common.json';
import frAiRename from './locales/fr/aiRename.json';
import deCommon from './locales/de/common.json';
import deAiRename from './locales/de/aiRename.json';
import ptPTCommon from './locales/pt-PT/common.json';
import ptPTAiRename from './locales/pt-PT/aiRename.json';
import ptBRCommon from './locales/pt-BR/common.json';
import ptBRAiRename from './locales/pt-BR/aiRename.json';
import lzhCommon from './locales/zh-Hant-x-lzh/common.json';
import lzhAiRename from './locales/zh-Hant-x-lzh/aiRename.json';
import lzhHansCommon from './locales/zh-Hans-x-lzh/common.json';
import lzhHansAiRename from './locales/zh-Hans-x-lzh/aiRename.json';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import enCommon from './locales/en/common.json';
import enAiRename from './locales/en/aiRename.json';
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNAiRename from './locales/zh-CN/aiRename.json';
import zhTWCommon from './locales/zh-TW/common.json';
import zhTWAIName from './locales/zh-TW/aiRename.json';
import jaCommon from './locales/ja/common.json';
import jaAiRename from './locales/ja/aiRename.json';
import koCommon from './locales/ko/common.json';
import koAiRename from './locales/ko/aiRename.json';
import { GHOST_OFFICIAL_ID_PREFIX } from '../../shared/ghost';
import { DEFAULT_LOCALE } from '../../shared/locale';
import { getEffectiveLocale } from '../lib/localePreference';

export {
  DEFAULT_LOCALE,
  resolvePreferredSystemLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
} from '../../shared/locale';
export type { LocalePreference, SupportedLocale } from '../../shared/locale';

// 凭证写入逃生口必须在全部语言里共用同一条安全命令；集中覆盖防止某个 locale 又退回
// “手动设置环境变量”的危险指引。对应跨 locale 契约由 devOAuthWritePolicy.test 锁住。
const resources = {
  'es': { common: esCommon, aiRename: esAiRename },
  'fr': { common: frCommon, aiRename: frAiRename },
  'de': { common: deCommon, aiRename: deAiRename },
  'pt-PT': { common: ptPTCommon, aiRename: ptPTAiRename },
  'pt-BR': { common: ptBRCommon, aiRename: ptBRAiRename },
  'zh-Hant-x-lzh': {
    common: {
      ...lzhCommon,
      chatgptAuthRecovery: {
        ...lzhCommon.chatgptAuthRecovery,
        devWriteBlocked: '開發之境，例以唯讀共用此機之 ChatGPT 登入，不得發起登入，亦不得改寫憑證。欲試 OAuth，唯執行：pnpm restart:desktop:remote -- --isolated-auth --isolated。指令碼驗明獨立沙箱後，自會開放寫入，毋須手設環境變數。',
      },
    },
    aiRename: lzhAiRename,
  },
  'zh-Hans-x-lzh': {
    common: {
      ...lzhHansCommon,
      chatgptAuthRecovery: {
        ...lzhHansCommon.chatgptAuthRecovery,
        devWriteBlocked: '开发之境，例以只读共用此机之 ChatGPT 登录，不得发起登录，亦不得改写凭证。欲试 OAuth，唯执行：pnpm restart:desktop:remote -- --isolated-auth --isolated。脚本验明独立沙箱后，自会开放写入，毋须手设环境变量。',
      },
    },
    aiRename: lzhHansAiRename,
  },
  en: {
    common: {
      ...enCommon,
      chatgptAuthRecovery: {
        ...enCommon.chatgptAuthRecovery,
        devWriteBlocked: 'Development builds use this computer’s ChatGPT sign-in read-only by default and cannot start OAuth or change its credentials. To test OAuth, run: pnpm restart:desktop:remote -- --isolated-auth --isolated. The restart script enables writes only after verifying the sandbox.',
      },
    },
    aiRename: enAiRename,
  },
  'zh-CN': {
    common: {
      ...zhCNCommon,
      chatgptAuthRecovery: {
        ...zhCNCommon.chatgptAuthRecovery,
        devWriteBlocked: '开发环境默认只读共享本机 ChatGPT 登录，不能发起登录或改写凭证。测试 OAuth 只能运行：pnpm restart:desktop:remote -- --isolated-auth --isolated。脚本验证独立沙箱后会自动开放写入，无需手动设置环境变量。',
      },
    },
    aiRename: zhCNAiRename,
  },
  'zh-TW': {
    common: {
      ...zhTWCommon,
      chatgptAuthRecovery: {
        ...zhTWCommon.chatgptAuthRecovery,
        devWriteBlocked: '開發環境預設以唯讀方式共用本機 ChatGPT 登入，不能發起登入或改寫憑證。測試 OAuth 只能執行：pnpm restart:desktop:remote -- --isolated-auth --isolated。指令碼驗證獨立沙箱後會自動開放寫入，無需手動設定環境變數。',
      },
    },
    aiRename: zhTWAIName,
  },
  ja: {
    common: {
      ...jaCommon,
      chatgptAuthRecovery: {
        ...jaCommon.chatgptAuthRecovery,
        devWriteBlocked: '開発環境では、このコンピューターの ChatGPT ログインを既定で読み取り専用として共有するため、OAuth の開始や認証情報の変更はできません。OAuth をテストする場合は、pnpm restart:desktop:remote -- --isolated-auth --isolated を実行してください。スクリプトはサンドボックスを検証した後にのみ書き込みを許可します。環境変数を手動で設定する必要はありません。',
      },
    },
    aiRename: jaAiRename,
  },
  ko: {
    common: {
      ...koCommon,
      chatgptAuthRecovery: {
        ...koCommon.chatgptAuthRecovery,
        devWriteBlocked: '개발 환경은 기본적으로 이 컴퓨터의 ChatGPT 로그인을 읽기 전용으로 공유하므로 OAuth를 시작하거나 자격 증명을 변경할 수 없습니다. OAuth를 테스트하려면 pnpm restart:desktop:remote -- --isolated-auth --isolated을 실행하세요. 스크립트가 샌드박스를 검증한 뒤에만 쓰기를 허용하므로 환경 변수를 직접 설정할 필요가 없습니다.',
      },
    },
    aiRename: koAiRename,
  },
} as const;

// 同步 init —— 没有 backend / detector / suspense，i18n.init 立即返回。
// 不 await 也安全：所有 t() 调用之前 init 已经完成 (本文件 import 即 init)。
void i18n.use(initReactI18next).init({
  resources,
  // 翻译资源热更新会重新执行本模块，不能把用户已选语言重置为默认英文。
  lng: getEffectiveLocale(),
  // 缺 key 回退英文。
  // 文言版缺 key 先落其现代底本（繁體 / 简体），再落英文。
  fallbackLng: {
    'zh-Hant-x-lzh': ['zh-TW', DEFAULT_LOCALE],
    'zh-Hans-x-lzh': ['zh-CN', DEFAULT_LOCALE],
    default: [DEFAULT_LOCALE],
  },
  defaultNS: 'common',
  ns: ['common', 'aiRename'],
  interpolation: {
    escapeValue: false, // React 已转义
    // 品牌名单一事实源:locale 文案里的 {{appName}} 全部由此注入,改名只改
    // @cindy/maker-shared/branding 的 BRAND_NAME(见该文件对"不跟随改名"标识符的说明)。
    //
    // pronoun:伙伴文案里指代该伙伴的第三人称。具体视图可按当前伙伴传入；这里给
    // 一个通用兜底，避免漏传时把 `{{pronoun}}` 原样显示给用户。
    // 用户装入通道只保留 cindy-。官方运行时前缀仍在 GHOST_OFFICIAL_ID_PREFIXES。
    defaultVariables: {
      appName: BRAND_NAME,
      pronoun: '这位伙伴',
      reservedGhostIdPrefixes: GHOST_OFFICIAL_ID_PREFIX,
    },
  },
  parseMissingKeyHandler(key: string, defaultValue?: string) {
    if (
      (key.startsWith('ipcError.') || key.startsWith('chat.remoteError.')) &&
      key !== 'ipcError.INTERNAL'
    ) {
      const lng = i18n.resolvedLanguage || i18n.language;
      const fallback =
        i18n.getResource(lng, 'common', 'ipcError.INTERNAL') ??
        i18n.getResource('en', 'common', 'ipcError.INTERNAL');
      if (typeof fallback === 'string') return fallback;
    }
    return defaultValue ?? key;
  },
  returnNull: false,
});

export { i18n };
export default i18n;
