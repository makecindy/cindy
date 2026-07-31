/**
 * 原生应用菜单四语标签的术语门禁。
 *
 * 为什么需要单独一个测试:`scripts/check-i18n-glossary.mjs` 只读 renderer 的 locale
 * JSON,扫不到这份手写 TS catalog。引入术语表那轮它就整个漏掉了——zh-CN 的 `issues`
 * 还写着「议题」(Issue 的禁用译法),三语的 `settings` / `checkForUpdates` 还带着
 * ASCII 三点省略号,而这是 macOS 上常驻屏幕顶端的菜单栏,比大多数界面文案更显眼。
 *
 * 断言集抽在 ./shadowCatalogGlossary,与可编辑控件右键菜单 catalog 共用;判定逻辑
 * 复用 scripts/shared/glossary-rules.mjs,与根门禁、mobile 影子 catalog 同一套,
 * 避免各处各写一份规则后悄悄漂移。
 */
import { APPLICATION_MENU_LABELS } from '../applicationMenuLabels';

import { describeShadowCatalogGlossary, flattenShadowCatalog } from './shadowCatalogGlossary';

describeShadowCatalogGlossary(
  '原生应用菜单标签符合术语表',
  flattenShadowCatalog(APPLICATION_MENU_LABELS, 'desktop:menu.'),
  '原生菜单',
);
