import { z } from 'zod';

/**
 * 数组类参数的误传形态自愈，imagesListSchema(PR #5649)与 merge 的
 * queued_message_ids(#6369)同一套口径的共享版。glm 等 openai-completions 兼容层
 * 把数组参数序列化成 <item> 重复标签，单元素时折叠成标量，实测四类形态：
 * 多套一层 [[a],[b]] → 拍平；XML 风格 {item:[a,b]} → 取 item；单元素折叠
 * {item:a} 与裸标量 a → [a]。其余原样交给 zod 报错。
 * 只用于「顶层是标量字符串数组」的参数；对象数组（如 ask_owner
 * 的 questions）的折叠发生在内层节点，本函数救不了，不要套。
 */
export function coerceStringArrayParam(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.some((item) => Array.isArray(item)) ? (value as unknown[]).flat(1) : value;
  }
  if (value && typeof value === 'object') {
    const item = (value as { item?: unknown }).item;
    if (item === undefined) return value;
    value = item;
    if (Array.isArray(value)) {
      return value.some((x) => Array.isArray(x)) ? (value as unknown[]).flat(1) : value;
    }
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return value;
}

/** 标量字符串数组参数的统一入口：coerce + 原数组 schema，元素校验照常生效。 */
export function stringArrayParam<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(coerceStringArrayParam, schema);
}
