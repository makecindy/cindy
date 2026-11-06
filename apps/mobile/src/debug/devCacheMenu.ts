import { DevSettings } from 'react-native';
import { clearCachedHomeListSnapshot } from '@/session/mobileHomeListCache';
import { clearCachedSessionMessages } from '@/session/mobileSessionMessageCache';

/**
 * Dev-only 调试入口:RN 开发者菜单(⌘D / 摇一摇)里加一项,一键清各层会话缓存 + reload,回到"全新冷开
 * 无缓存"状态(免去手动 rm AsyncStorage)。严格 __DEV__ gate —— 生产 / TestFlight 绝不注册、不可达。
 * 不往正式 UI 加任何按钮(产品方要求),只挂在开发者菜单。
 */

// 模块级防重:Fast-Refresh 会重跑 effect,避免重复注册同名菜单项。
let registered = false;

export function registerDevCacheMenu(): void {
  if (!__DEV__) return;
  if (registered) return;
  registered = true;
  DevSettings.addMenuItem('🧹 Clear session caches & reload', () => {
    void (async () => {
      try {
        await clearCachedSessionMessages(); // AsyncStorage 消息缓存
        await clearCachedHomeListSnapshot(); // AsyncStorage 首页设备+会话列表快照
        DevSettings.reload();
      } catch (error) {
        // 沿用 mobile 本地日志约定(见 DeviceLinkContext 的前缀化 error 日志);dev-only,不留无前缀裸日志。
        console.error('[dev-cache-menu] clear caches failed:', error);
      }
    })();
  });
}
