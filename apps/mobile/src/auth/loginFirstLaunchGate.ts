import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 登录首启亮色门(主题跟随产品逻辑,DESIGN.md §16.5):首次打开 Cindy →
 * 亮色登录界面(默认);第二次起 → 跟随用户上一次使用的模式(手机 = 系统
 * light/dark)。
 *
 * 门在 MobileLoginHandoffStage(登录/闸门唯一 full-viewport 品牌宿主)层
 * 消费——splash/闸门/登录页共享同一覆盖,首启不会出现「品牌舞台暗色 →
 * 登录亮色」的闪变。模块加载即预热 AsyncStorage 读(下方 eager kick),
 * 首帧前缓存通常已就绪;万一未就绪,状态为 'pending',品牌宿主此时**不
 * 渲染品牌内容**(结构上杜绝「先透传系统暗色、判定后切亮」的错误主题帧),
 * 判定完成后 'light'(真首启强制亮)/'passthrough'(老用户透传,零扰动)。
 */
const LOGIN_FIRST_LAUNCH_KEY = 'cindy.login.firstLaunchLightShown';

let cached: boolean | null = null;
let pending: Promise<boolean> | null = null;
const listeners = new Set<(value: boolean) => void>();

function readGate(): Promise<boolean> {
  if (cached !== null) return Promise.resolve(cached);
  if (pending) return pending;
  pending = AsyncStorage.getItem(LOGIN_FIRST_LAUNCH_KEY)
    .then((v) => {
      const first = v == null;
      if (first) {
        void AsyncStorage.setItem(LOGIN_FIRST_LAUNCH_KEY, String(Date.now()));
      }
      cached = first;
      listeners.forEach((l) => l(first));
      return first;
    })
    .catch(() => {
      // 存储不可用时不强制亮色,跟随系统兜底
      cached = false;
      listeners.forEach((l) => l(false));
      return false;
    });
  return pending;
}

// eager kick:模块 import 时即发起读,首帧前缓存通常已就绪
void readGate();

/** 首启亮色门三态:pending = AsyncStorage 未决(eager kick 下近零时长),
 * light = 真首启强制亮色,passthrough = 老用户透传全局主题(零扰动)。 */
export type LoginFirstLaunchGateState = 'light' | 'passthrough' | 'pending';

/** 当前门状态(无副作用同步读取,供 hook 初值与测试用)。 */
export function getLoginFirstLaunchGateState(): LoginFirstLaunchGateState {
  if (cached === null) return 'pending';
  return cached ? 'light' : 'passthrough';
}

/**
 * 首启亮色门 hook。'pending' 期间消费方不得按任何主题渲染品牌内容——
 * 透传会让真首启在系统暗色下先画一帧暗色再切亮(Greptile P1),强制亮色
 * 又会打扰老用户;唯一无错误帧的选择是等判定完成(近零时长)再渲染。
 */
export function useLoginFirstLaunchLight(): LoginFirstLaunchGateState {
  const [state, setState] = useState<LoginFirstLaunchGateState>(getLoginFirstLaunchGateState);
  useEffect(() => {
    if (cached !== null) {
      setState(getLoginFirstLaunchGateState());
      return;
    }
    const listener = () => setState(getLoginFirstLaunchGateState());
    listeners.add(listener);
    void readGate();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}
