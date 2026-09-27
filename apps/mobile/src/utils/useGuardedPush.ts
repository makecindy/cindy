import { useCallback, useEffect, useMemo } from 'react';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';

import { createRefocusReset, forwardNavigationLock, navigationTargetKey } from './navigationLock';

type Router = ReturnType<typeof useRouter>;
type Href = Parameters<Router['push']>[0];

/**
 * 有防重复守卫的 router.push(锁语义见 navigationLock.ts)。
 * 列表页 / 头部按钮等所有用户可快速连点的前进导航入口统一走这里,
 * 不要在调用点再裸调 router.push。
 *
 * 锁的释放(抑制只应覆盖「导航在途」期间,review P2 反馈):
 *  - 转场动画完成(transitionEnd)即释放——排队的补点 press 在 JS 恢复后、
 *    转场完成前就已 fire 并被挡下;转场完成后目标页上的首次点击是新意图,
 *    不该再被来源页设下的窗口压住。
 *  - 本页从下一层返回、重新获得焦点时释放(首挂载 focus 跳过,原因见
 *    createRefocusReset)——兜住 transitionEnd 不触发的平台(web)。
 *
 * 焦点门(时间窗之外的确定性防线):发起页失焦后的 push 请求一律丢弃。
 * 背景(2026-07-18 实锤):JS 长停摆(microtask 风暴)会把用户的补点分散到多个
 * 恢复间隙里处理,彼此墙钟间隔可超过 SAME_TARGET_WINDOW_MS,且间隙里 transitionEnd
 * 已提前放锁——时间窗对「跨停摆补点」整体失效,同一会话被连开 N 层。焦点是
 * 确定性信号:第一次点击的导航 dispatch 即让本页失焦,其后处理到的补点必然
 * isFocused()===false,丢弃即用户想要的结果(导航已经在路上)。
 */
/**
 * 返回值 = 本次 push 是否被接受。两道门(失焦、前进锁)都是静默丢弃,调用方若要
 * 在导航成功后才做副作用(如清未读),必须据此判断,不能假定调用即生效。
 * 既有调用方忽略返回值即可,行为不变。
 */
export function useGuardedPush(): (href: Href) => boolean {
  const router = useRouter();
  const navigation = useNavigation();
  useEffect(() => {
    // native-stack 的 transitionEnd 不在默认 NavigationProp 事件类型里,宽化注册;
    // 不支持的平台不会触发,行为回退到 refocus 释放 + 时间窗兜底。
    const nav = navigation as unknown as {
      addListener: (type: string, callback: () => void) => () => void;
    };
    return nav.addListener('transitionEnd', () => {
      forwardNavigationLock.reset();
    });
  }, [navigation]);
  const onFocus = useMemo(() => createRefocusReset(forwardNavigationLock), []);
  useFocusEffect(useCallback(() => {
    onFocus();
  }, [onFocus]));
  return useCallback((href: Href) => {
    if (navigation.isFocused() === false) return false;
    if (!forwardNavigationLock.shouldAllow(navigationTargetKey(href))) return false;
    router.push(href);
    return true;
  }, [navigation, router]);
}
