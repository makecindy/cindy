/**
 * cindy_schedulerToolRegistry.ts
 * ---------------------------------------------------------------------------
 * Mirrors FeishuBotToolRegistry / FeishuToolRegistry — fine-grained scheduler
 * tools register here, NOT directly on the McpServer. The MCP server only
 * exposes `list_tools` + `call_tool` entry tools, keeping startup context cost
 * low. INVALID_ARGS surfaces the JSON schema so the model self-corrects.
 *
 * One category 'scheduler' for now. Slot is reserved as a union to keep room
 * for future families (e.g. 'scheduler_template') without changing registry
 * shape.
 */

import { z } from 'zod';

export type SchedulerToolCategory = 'scheduler';

export type SchedulerToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface SchedulerToolResult {
  content: SchedulerToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type SchedulerToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<SchedulerToolResult>;

export interface SchedulerToolDef {
  name: string;
  category: SchedulerToolCategory;
  description: string;
  rules?: string[];
  inputShape: z.ZodRawShape;
  handler: SchedulerToolHandler;
}

export interface SchedulerToolSummary {
  name: string;
  category: SchedulerToolCategory;
  description: string;
  rules?: string[];
}

export class SchedulerToolRegistry {
  private readonly tools = new Map<string, SchedulerToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: SchedulerToolCategory;
    description: string;
    rules?: string[];
    inputShape: T;
    handler: SchedulerToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindy_schedulerToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as SchedulerToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): SchedulerToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: SchedulerToolCategory): SchedulerToolSummary[] {
    const all: SchedulerToolSummary[] = [];
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

  collectRuleKeys(category?: SchedulerToolCategory): string[] {
    const set = new Set<string>();
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      for (const k of t.rules ?? []) set.add(k);
    }
    return Array.from(set);
  }

  listCategories(): SchedulerToolCategory[] {
    const set = new Set<SchedulerToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<SchedulerToolResult> {
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

    // strict:未知字段直接判失败(而非默默剥掉)。否则 agent 传了不支持 / 拼错的字段
    // 会"返回成功、实际忽略",误导其以为生效(典型:旧版客户端收到新字段
    // bindToCurrentSession 时静默丢弃)。失败分支已带 schema + hint,agent 可据此自纠重试。
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
