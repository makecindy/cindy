/**
 * cindy_memoryToolRegistry.ts
 * ---------------------------------------------------------------------------
 * Mirror of SchedulerToolRegistry / FeishuBotToolRegistry — memory tools
 * register here (not on McpServer directly), keeping the entry-tool surface to
 * just `list_tools` + `call_tool` for token economy.
 *
 * Categories:
 *  - read     : memory_read / memory_list
 *  - write    : memory_write / memory_delete
 *  - maintain : memory_consolidate / memory_review
 *  - search   : memory_search
 */

import { z } from 'zod';

export type MemoryToolCategory = 'read' | 'write' | 'maintain' | 'search';

export type MemoryToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface MemoryToolResult {
  content: MemoryToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type MemoryToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<MemoryToolResult>;

export interface MemoryToolDef {
  name: string;
  category: MemoryToolCategory;
  description: string;
  rules?: string[];
  inputShape: z.ZodRawShape;
  handler: MemoryToolHandler;
}

export interface MemoryToolSummary {
  name: string;
  category: MemoryToolCategory;
  description: string;
  rules?: string[];
}

export class MemoryToolRegistry {
  private readonly tools = new Map<string, MemoryToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: MemoryToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    handler: MemoryToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindy_memoryToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as MemoryToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): MemoryToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: MemoryToolCategory): MemoryToolSummary[] {
    const all: MemoryToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({
        name: t.name,
        category: t.category,
        description: t.description,
        ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
      });
    }
    return all;
  }

  listCategories(): MemoryToolCategory[] {
    const set = new Set<MemoryToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<MemoryToolResult> {
    const def = this.tools.get(name);
    if (!def) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'UNKNOWN_TOOL',
              data: {
                requested: name,
                available: Array.from(this.tools.keys()),
                hint: '调用 list_tools 查看完整工具列表',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    // strict:未知字段直接判失败(而非默默剥掉)。否则 agent 传了拼错 / 不支持的字段会
    // "返回成功、实际忽略",误导其以为生效(典型:camelCase 写成 sessionIds 而非 session_ids)。
    // 失败分支已带 schema + hint,agent 可据此自纠重试。
    const objSchema = z.strictObject(def.inputShape);
    const parsed = objSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      let jsonSchema: unknown;
      try {
        jsonSchema = z.toJSONSchema(objSchema);
      } catch {
        jsonSchema = '<schema serialization failed>';
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              errorCode: 'INVALID_ARGS',
              data: {
                tool: name,
                // received: 回显收到的顶层 keys — 只回 schema 时模型看不出自己是多包了一层信封
                // (keys=["args"]) 还是拍平了 (keys=参数字段), 实测 2026-10-31 三个会话因此连续盲试。
                received: rawArgs && typeof rawArgs === 'object'
                  ? Object.keys(rawArgs as Record<string, unknown>)
                  : [],
                validation_errors: parsed.error.issues,
                schema: jsonSchema,
                hint: '请按 schema 修正参数后重试',
              },
            }),
          },
        ],
        isError: true,
      };
    }

    return def.handler(parsed.data as Record<string, unknown>);
  }
}
