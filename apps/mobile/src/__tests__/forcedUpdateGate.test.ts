import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 强更阻断契约(读源码断言)。
 *
 * 回归背景:强更曾经是一个 `cancelable: false` 的单按钮 Alert —— 但 RN Alert 的按钮
 * 点一下就关(cancelable 只挡点外部 / 返回键),弹窗消失后底下的 App 照旧可用,且模块级
 * 去重让本进程内不再弹。那是"强提醒"而非"强制"。现在强更必须是 root 层的阻断屏:
 * 命中门槛就不挂业务树。
 */
describe('强更阻断闸门', () => {
  const read = (rel: string) =>
    readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');

  /**
   * 去掉行注释与块注释后再断言"某段代码不存在"。
   * 直接搜关键字会误伤解释这段历史的注释;搜 `{ cancelable:` 又依赖空格写法
   * (`{cancelable:` 就漏检)。剥注释后按关键字断言,两个问题一起消掉。
   */
  const readCode = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n');

  it('root layout 用 forcedUpdate 状态阻断业务树,唯一出口是「去更新」', () => {
    const layout = read('app/_layout.tsx');

    expect(layout).toContain("from '@/update/forcedUpdateStore'");
    expect(layout).toContain('const forcedUpdate = useForcedUpdate();');
    // 阻断分支必须先于 ready 分支(ready 才会挂 RootAfterEndpoints 业务树)。
    expect(layout.indexOf('} else if (forcedUpdate) {')).toBeGreaterThan(0);
    expect(layout.indexOf('} else if (forcedUpdate) {')).toBeLessThan(
      layout.indexOf('body = <RootAfterEndpoints />;'),
    );
    expect(layout).toContain('<ForcedUpdateGateContent target={forcedUpdate} />');
    expect(layout).toContain("actionLabel={t('update.goUpdate')}");
    // 阻断屏不得有"稍后 / 跳过"出口。
    expect(layout).not.toContain('update.later');
  });

  it('强更路径不再走 Alert:promptBundleUpdate 直接进入阻断态', () => {
    const prompt = read('src/update/useBundleUpdatePrompt.ts');
    const promptCode = readCode('src/update/useBundleUpdatePrompt.ts');

    expect(prompt).toContain('enterForcedUpdate(evaluation.target)');
    // 不可取消弹窗是被替换掉的旧实现,不允许以任何写法回归。
    expect(promptCode).not.toMatch(/cancelable/);
    expect(promptCode).not.toContain("i18n.t('update.forcedTitle')");
    // 拿不到安装地址时不得进入阻断态(否则把用户关进没有出口的屏)。
    expect(prompt).toContain('if (!url) return;');
  });

  it('阻断屏自带回前台重新核对:服务端撤回门槛后不必杀进程', () => {
    const layout = read('app/_layout.tsx');
    const recheck = read('src/update/forcedUpdateRecheck.ts');

    // 阻断期间业务树不挂载 → resume 通道停摆,恢复入口必须挂在阻断屏自己身上。
    expect(layout).toContain("from '@/update/useForcedUpdateRecheck'");
    expect(layout).toContain('useForcedUpdateRecheck();');
    // 解除方向 fail-closed:只有成功拉到 /latest 且判定不再强更才解除,
    // 拉取失败 / 记录解析不出 / 拿不到本机 version 一律维持阻断,不能靠断网绕过。
    expect(recheck).toContain(
      "if (!record || !currentRuntimeVersion || !currentVersion) return 'error';",
    );
    expect(recheck).toContain("return 'error'");
    // 仍强更时必须刷新 target:服务端可能只修正了坏掉的安装地址。
    expect(recheck).toContain('deps.onStillForced(evaluation.target, startRevision)');
    // /latest 是可变指针,minVersion 还会被原地改(set-mobile-min-version):边缘旧副本
    // 两个方向都会错判(旧记录带门槛 → 误挡;旧记录无门槛 → 误放行),所以所有 /latest
    // 读取都必须绕缓存,不是只有核对这一条。
    const fetchLatest = readCode('src/update/fetchLatestRelease.ts');
    expect(fetchLatest).toContain("'cache-control': 'no-cache'");
    expect(fetchLatest).toContain('&t=${Date.now()}');
    // 光靠 AppState 跳变不够:用户停在阻断屏上不动时没有任何跳变,必须有定时兜底。
    const recheckHook = readCode('src/update/useForcedUpdateRecheck.ts');
    expect(recheckHook).toContain('rechecker.handleTick()');
    expect(recheckHook).toContain('clearInterval(timer)');
    // 但兜底只在前台敲门:后台定时器仍可能触发,那会白发 /latest(耗电 + 后台网络)。
    expect(recheckHook).toContain("if (AppState.currentState !== 'active') return;");
    // 在途期间若有更新的观察写入 store,本次旧结论必须作废(compare-and-set)。
    expect(recheck).toContain('const startRevision = deps.getRevision?.();');
    expect(recheck).toContain('deps.onCleared(startRevision)');
  });

  it('阻断态只存内存,不持久化(服务端撤回门槛后用户不能被本地缓存锁死)', () => {
    const store = read('src/update/forcedUpdateStore.ts');

    // 与 otaReloadGuard 的关键区别:那是防故障循环、必须落盘计数并自带放弃条件;
    // 这是产品意图的阻断,不落盘本身就是自愈路径。
    expect(store).not.toContain('AsyncStorage');
    expect(store).toContain('export function enterForcedUpdate');
  });
});
