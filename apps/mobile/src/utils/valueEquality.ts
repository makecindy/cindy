/**
 * 内容等值工具集:供「引用调和 / memo 比较器」使用的纯函数。
 * ---------------------------------------------------------------------------
 * 背景(2026-07-18 首页列表重渲染风暴):store 高频 emit 下,派生索引(Map)与列表
 * 行 props 每轮都换新引用,memo/useMemo 全部失效,整列表反复重渲染把 JS 线程打满。
 * 修法是在各消费点做「内容未变 → 保留旧引用」的调和,这里收敛判定逻辑本体。
 * 语义取舍:JSON.stringify 兜底比较对函数值不敏感(函数被序列化丢弃)、对键序敏感
 * (同构造路径的对象键序稳定)。误判方向是安全侧:比不出相等 → 走原重建/重渲染路径。
 */

export function isPlainObjectOrArray(value: unknown): value is object {
  return !!value && typeof value === 'object';
}

/** 深内容等值:Object.is 快路径,对象/数组退 JSON.stringify(任一侧不可序列化即判不等)。 */
export function deepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isPlainObjectOrArray(a) && isPlainObjectOrArray(b)) {
    const sa = safeStableStringify(a);
    // 双侧都序列化失败(循环引用等)不得判等——那会静默吞掉真实变化(review P2)。
    return sa !== null && sa === safeStableStringify(b);
  }
  return false;
}

/** 数组逐元素引用等值:元素本身引用稳定(如 store 调和过的消息对象)时,用它保住派生数组的引用。 */
export function sameArrayIdentity<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Map 内容等值:键集合一致且逐值 valueEqual(默认 deepValueEqual)。 */
export function mapContentEqual<K, V>(
  a: ReadonlyMap<K, V>,
  b: ReadonlyMap<K, V>,
  valueEqual: (x: V, y: V) => boolean = deepValueEqual,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key)) return false;
    if (!valueEqual(value, b.get(key) as V)) return false;
  }
  return true;
}

/**
 * React.memo 数据 props 比较器:全键逐一深比较,**函数 prop 跳过**。
 * 适用前提(使用处必须逐一审计并注释):所有函数 prop 的闭包语义稳定(只闭合
 * router / store / setState 等稳定引用),新旧闭包可互换。数据变化(含嵌套对象)
 * 一律如实触发重渲染,不会造成数据级 stale。
 */
export function dataPropsEqual(
  prev: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const a = prev[key];
    const b = next[key];
    if (typeof a === 'function' && typeof b === 'function') continue;
    if (!deepValueEqual(a, b)) return false;
  }
  return true;
}

function safeStableStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
