/**
 * 可编辑控件右键菜单四语标签的术语门禁。
 *
 * 与应用菜单同理:这份 catalog 是用户可见文案但不走 i18next,根门禁扫不到它。
 * 菜单里的「粘贴」「全选」等词直接对标系统级编辑命令,一旦译法漂移会比普通界面
 * 文案更刺眼,所以同样纳入术语与标点门禁。
 */
import { EDITABLE_CONTEXT_MENU_LABELS } from '../editableContextMenuLabels';

import { describeShadowCatalogGlossary, flattenShadowCatalog } from './shadowCatalogGlossary';

describeShadowCatalogGlossary(
  '可编辑控件右键菜单标签符合术语表',
  flattenShadowCatalog(EDITABLE_CONTEXT_MENU_LABELS, 'desktop:editMenu.'),
  '可编辑控件右键菜单',
);
