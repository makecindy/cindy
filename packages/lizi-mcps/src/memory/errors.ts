/**
 * memory/errors.ts
 *
 * 把 maker-core MemoryError + manager 异常翻译成 MCP tool result 错误码。
 *
 * 错误码集 (跟 IPC 层未来要对齐, 当前 IPC 还没接 maker memory, Phase 7 收敛):
 *  - MAKER_MEMORY_NOT_READY : manager 没注入 / mode != 'maker' / store init 失败
 *  - NOT_FOUND              : memory 文件不存在 (read/delete/append/update)
 *  - ALREADY_EXISTS         : create 撞名 — LLM 应改 mode:'update'
 *  - INVALID_PARAMS         : schema / 路径 / size / frontmatter 等业务校验
 *  - INTERNAL               : 其他底层错
 */

export type MemoryToolErrorCode =
  | 'MAKER_MEMORY_NOT_READY'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'INVALID_PARAMS'
  | 'INTERNAL';

export interface MemoryToolError {
  code: MemoryToolErrorCode;
  message: string;
}

/** 把 unknown error 分类成结构化 {code, message}. 纯函数, 不抛 */
export function classifyMemoryError(err: unknown): MemoryToolError {
  const message = err instanceof Error ? err.message : String(err);
  // maker-core MemoryError 抛的 message 形如 "memory:<code> <description>",
  // 见 packages/maker-core/src/memory/types.ts MemoryError.constructor
  const tag = message.match(/^memory:([a-z-]+)\s/);
  if (tag) {
    const code = tag[1];
    if (code === 'not-found') return { code: 'NOT_FOUND', message };
    if (code === 'already-exists') return { code: 'ALREADY_EXISTS', message };
    if (
      code === 'invalid-type' ||
      code === 'invalid-slug' ||
      code === 'invalid-frontmatter' ||
      code === 'invalid-filename' ||
      code === 'description-too-long' ||
      code === 'title-too-long' ||
      code === 'description-has-newline' ||
      code === 'shard-too-large' ||
      code === 'path-traversal'
    ) {
      return { code: 'INVALID_PARAMS', message };
    }
    if (code === 'io-error') return { code: 'INTERNAL', message };
    // owner 作用域守卫抛的 not-ready (见 manager.ts ensureOwnerScope) — 与
    // 「真空库返回 ok+[]」可区分 (issue #2341)。
    if (code === 'not-ready') return { code: 'MAKER_MEMORY_NOT_READY', message };
  }
  // manager 显式抛的两种状态错
  if (/manager not (?:available|ready|injected)|memory disabled/i.test(message)) {
    return { code: 'MAKER_MEMORY_NOT_READY', message };
  }
  return { code: 'INTERNAL', message };
}
