/**
 * i18n 入口 —— init i18next，导出常量与类型。
 *
 * 设计要点：
 * - 只静态打包英文（fallback 语言）；其余语言包按需动态 import，每个窗口只解析当前语言及其
 *   回退链，不再把 12 种语言（约 13 MB）都放进首屏。
 * - 当前语言为英文时 init 同步完成；其他语言由 `i18nReady` 表示加载完成。renderer 分发入口
 *   （index.tsx）先等它再加载各窗口模块，React 首屏仍直接是目标语言，不闪英文。
 * - 切换语言走 i18n.changeLanguage：先加载目标语言包，加载完才切换并通知 React 重渲染。
 * - 需要在「非当前语言」下读取的少量文案（例如跨语言识别旧标题、模型中文名搜索）不依赖
 *   语言包是否已加载，走 crossLocaleStrings。
 * - 默认 namespace 为 'common'；体积较小、边界清晰的功能文案可独立拆分。
 * - fallbackLng：缺 key 时不显示 key 本身,直接回退英文。
 * - 不接 LanguageDetector，初始化与 useLocale 共用现有语言偏好。
 *   'system' 的实际语言由 main 侧读取 OS 首选语言后传入 renderer。
 */

import i18n, { type BackendModule, type ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import enCommon from './locales/en/common.json';
import enAiRename from './locales/en/aiRename.json';
import { GHOST_OFFICIAL_ID_PREFIX } from '../../shared/ghost';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/locale';
import { createLogger } from '../lib/logger';
import { getEffectiveLocale, LOCALE_STORAGE_KEY } from '../lib/localePreference';

const log = createLogger('i18n');

export {
  DEFAULT_LOCALE,
  resolvePreferredSystemLocale,
  resolveSystemLocale,
  SUPPORTED_LOCALES,
} from '../../shared/locale';
export type { LocalePreference, SupportedLocale } from '../../shared/locale';

type Namespace = 'common' | 'aiRename';
type JsonModule = { default: Record<string, unknown> };
type LazyLocale = Exclude<SupportedLocale, 'en'>;

// 每个路径都写成字面量：Vite 据此拆出独立分包；ui:check 的 esbuild 打包（不拆分）也能解析。
const LOCALE_LOADERS: Record<LazyLocale, Record<Namespace, () => Promise<JsonModule>>> = {
  'zh-CN': {
    common: () => import('./locales/zh-CN/common.json'),
    aiRename: () => import('./locales/zh-CN/aiRename.json'),
  },
  'zh-TW': {
    common: () => import('./locales/zh-TW/common.json'),
    aiRename: () => import('./locales/zh-TW/aiRename.json'),
  },
  ja: {
    common: () => import('./locales/ja/common.json'),
    aiRename: () => import('./locales/ja/aiRename.json'),
  },
  ko: {
    common: () => import('./locales/ko/common.json'),
    aiRename: () => import('./locales/ko/aiRename.json'),
  },
  es: {
    common: () => import('./locales/es/common.json'),
    aiRename: () => import('./locales/es/aiRename.json'),
  },
  fr: {
    common: () => import('./locales/fr/common.json'),
    aiRename: () => import('./locales/fr/aiRename.json'),
  },
  de: {
    common: () => import('./locales/de/common.json'),
    aiRename: () => import('./locales/de/aiRename.json'),
  },
  'pt-PT': {
    common: () => import('./locales/pt-PT/common.json'),
    aiRename: () => import('./locales/pt-PT/aiRename.json'),
  },
  'pt-BR': {
    common: () => import('./locales/pt-BR/common.json'),
    aiRename: () => import('./locales/pt-BR/aiRename.json'),
  },
  'zh-Hant-x-lzh': {
    common: () => import('./locales/zh-Hant-x-lzh/common.json'),
    aiRename: () => import('./locales/zh-Hant-x-lzh/aiRename.json'),
  },
  'zh-Hans-x-lzh': {
    common: () => import('./locales/zh-Hans-x-lzh/common.json'),
    aiRename: () => import('./locales/zh-Hans-x-lzh/aiRename.json'),
  },
};

// 凭证写入逃生口必须在全部语言里共用同一条安全命令；集中覆盖防止某个 locale 又退回
// “手动设置环境变量”的危险指引。对应跨 locale 契约由 devOAuthWritePolicy.test 锁住。
const DEV_WRITE_BLOCKED: Partial<Record<SupportedLocale, string>> = {
  'zh-Hant-x-lzh': '開發之境，例以唯讀共用此機之 ChatGPT 登入，不得發起登入，亦不得改寫憑證。欲試 OAuth，唯執行：pnpm restart:desktop:remote -- --isolated-auth --isolated。指令碼驗明獨立沙箱後，自會開放寫入，毋須手設環境變數。',
  'zh-Hans-x-lzh': '开发之境，例以只读共用此机之 ChatGPT 登录，不得发起登录，亦不得改写凭证。欲试 OAuth，唯执行：pnpm restart:desktop:remote -- --isolated-auth --isolated。脚本验明独立沙箱后，自会开放写入，毋须手设环境变量。',
  en: 'Development builds use this computer’s ChatGPT sign-in read-only by default and cannot start OAuth or change its credentials. To test OAuth, run: pnpm restart:desktop:remote -- --isolated-auth --isolated. The restart script enables writes only after verifying the sandbox.',
  'zh-CN': '开发环境默认只读共享本机 ChatGPT 登录，不能发起登录或改写凭证。测试 OAuth 只能运行：pnpm restart:desktop:remote -- --isolated-auth --isolated。脚本验证独立沙箱后会自动开放写入，无需手动设置环境变量。',
  'zh-TW': '開發環境預設以唯讀方式共用本機 ChatGPT 登入，不能發起登入或改寫憑證。測試 OAuth 只能執行：pnpm restart:desktop:remote -- --isolated-auth --isolated。指令碼驗證獨立沙箱後會自動開放寫入，無需手動設定環境變數。',
  ja: '開発環境では、このコンピューターの ChatGPT ログインを既定で読み取り専用として共有するため、OAuth の開始や認証情報の変更はできません。OAuth をテストする場合は、pnpm restart:desktop:remote -- --isolated-auth --isolated を実行してください。スクリプトはサンドボックスを検証した後にのみ書き込みを許可します。環境変数を手動で設定する必要はありません。',
  ko: '개발 환경은 기본적으로 이 컴퓨터의 ChatGPT 로그인을 읽기 전용으로 공유하므로 OAuth를 시작하거나 자격 증명을 변경할 수 없습니다. OAuth를 테스트하려면 pnpm restart:desktop:remote -- --isolated-auth --isolated을 실행하세요. 스크립트가 샌드박스를 검증한 뒤에만 쓰기를 허용하므로 환경 변수를 직접 설정할 필요가 없습니다.',
};

function withLocaleOverrides(
  locale: string,
  namespace: string,
  bundle: Record<string, unknown>,
): Record<string, unknown> {
  const devWriteBlocked = DEV_WRITE_BLOCKED[locale as SupportedLocale];
  if (namespace !== 'common' || devWriteBlocked === undefined) return bundle;
  return {
    ...bundle,
    chatgptAuthRecovery: {
      ...(bundle.chatgptAuthRecovery as Record<string, unknown> | undefined),
      devWriteBlocked,
    },
  };
}

/**
 * 按需加载语言包。i18next 解析回退链时也会请求 `zh`、`pt` 这类不单独提供的语言代码，
 * 返回空包即可，查找会继续落到 fallbackLng。加载失败不重试（本地分包读不到说明安装已损坏，
 * 重试只会推迟首屏）：该语言在本窗口回退英文，记一条日志，窗口重新打开时会再加载。
 */
const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, namespace, callback) {
    const load = LOCALE_LOADERS[language as LazyLocale]?.[namespace as Namespace];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (module) => callback(null, withLocaleOverrides(language, namespace, module.default) as ResourceKey),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), false),
    );
  },
};

const initialized = i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: withLocaleOverrides('en', 'common', enCommon),
        aiRename: enAiRename,
      },
    },
    // 英文之外的语言由 lazyLocaleBackend 补齐。
    partialBundledLanguages: true,
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

/**
 * 初始语言（含回退链）已加载完成。英文时已同步完成；加载失败也会 resolve，此时回退英文显示。
 * 渲染任何窗口之前先等它，避免首屏先出英文再切换。
 */
export const i18nReady: Promise<void> = initialized.then(
  () => undefined,
  () => undefined,
);

// 只记语言与 namespace，不记错误文本（其中可能带安装路径）。
i18n.on('failedLoading', (lng: string, ns: string) => {
  log.warn('locale bundle failed to load; falling back to English', { lng, ns });
});

// 用户在主窗口切换语言会写入 localStorage；同源的其他常驻窗口（预热的截图、贴图、录屏预览、
// 远程桌面等）借 storage 事件提前加载新语言包。它们之后收到语言切换消息时 changeLanguage
// 立即完成，界面不会先显示旧语言再切换。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === LOCALE_STORAGE_KEY) void i18n.loadLanguages(getEffectiveLocale());
  });
}

export { i18n };
export default i18n;
