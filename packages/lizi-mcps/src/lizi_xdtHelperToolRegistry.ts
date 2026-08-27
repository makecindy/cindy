/**
 * lizi_xdtHelperToolRegistry.ts
 * ---------------------------------------------------------------------------
 * Mirrors SchedulerToolRegistry — fine-grained xdt-helper tools register here,
 * NOT directly on the McpServer. The MCP server only exposes `list_tools` +
 * `call_tool` entry tools, keeping startup context cost low.
 *
 * 当前只有一个 category 'cindy' 一个工具 get_capabilities,registry 看似过度设计,
 * 但保留它的原因是:
 *  1. 与其他 lizi_* server 一致(维护成本低,新人一眼看懂)
 *  2. 让 list_tools/call_tool 入口代价仍只有两条工具 schema 进系统提示,
 *     真正的 get_capabilities 描述藏在 list_tools 返回里
 *  3. 未来要加 get_shortcuts / get_changelog 这类同源工具时直接 register 即可
 */

import { z } from 'zod';

/**
 * Category 分两类:
 *  - 'cindy'   : 只读自省 (get_capabilities / get_current_session_id)
 *  - 'history' : 只读查询本地数据库里的历史聊天数据 (list_workdirs /
 *                list_sessions / get_chat_history / search_chat_history),
 *                方便用户自己组织 memory / 知识库系统
 *
 * history 单独成类是因为它和 cindy 自省虽都只读, 但语义不同 (自省 = "我是谁",
 * 查询 = "我和你聊过啥"), 拆开后 list_tools 入口更清晰。
 *
 * 第三类 'control' 是会话控制面：标题 / 归档，以及跨 session 的本人队列消息控制、
 * same-turn 插话、优雅停止与只读运行探针。
 *
 * 第四类 'feedback' 是向 Cindy 官方提交反馈的工具 (submit_github_issue),
 * 有副作用但提交前由 host 弹系统确认卡片把关。
 *
 * 第五类 'handoff' 是 session 间 handoff 原语 send_to_session(投递消息到一个已知
 * session,或为业务对象新建专属 session),供 skill 路由用。单独成类(不并入 control)
 * 是为了让 list_tools(control) 的"改会话标题"结果里不混入 handoff,避免 LLM 在"改名"
 * 意图下误选 send_to_session。
 */
export type XdtHelperToolCategory = 'cindy' | 'history' | 'control' | 'feedback' | 'handoff';

export type XdtHelperToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface XdtHelperToolResult {
  content: XdtHelperToolContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

export type XdtHelperToolHandler<T = Record<string, unknown>> = (
  args: T,
) => Promise<XdtHelperToolResult>;

export interface XdtHelperToolDef {
  name: string;
  category: XdtHelperToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  handler: XdtHelperToolHandler;
}

export interface XdtHelperToolSummary {
  name: string;
  category: XdtHelperToolCategory;
  description: string;
}

export class XdtHelperToolRegistry {
  private readonly tools = new Map<string, XdtHelperToolDef>();

  register<T extends z.ZodRawShape>(def: {
    name: string;
    category: XdtHelperToolCategory;
    description: string;
    inputShape: T;
    handler: XdtHelperToolHandler<{ [K in keyof T]: z.infer<T[K]> }>;
  }): void {
    if (this.tools.has(def.name)) {
      throw new Error(`[cindyHelperToolRegistry] duplicate tool name: ${def.name}`);
    }
    this.tools.set(def.name, def as unknown as XdtHelperToolDef);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): XdtHelperToolDef | undefined {
    return this.tools.get(name);
  }

  list(category?: XdtHelperToolCategory): XdtHelperToolSummary[] {
    const all: XdtHelperToolSummary[] = [];
    for (const t of this.tools.values()) {
      if (category && t.category !== category) continue;
      all.push({
        name: t.name,
        category: t.category,
        description: t.description,
      });
    }
    return all;
  }

  listCategories(): XdtHelperToolCategory[] {
    const set = new Set<XdtHelperToolCategory>();
    for (const t of this.tools.values()) set.add(t.category);
    return Array.from(set);
  }

  async call(name: string, rawArgs: unknown): Promise<XdtHelperToolResult> {
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
