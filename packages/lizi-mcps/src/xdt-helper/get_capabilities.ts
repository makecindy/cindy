/**
 * xdt-helper/get_capabilities.ts — get_capabilities tool
 *
 * 渐进式发现:
 *  - 不传 key  → 返回全部 {key, title, oneLiner} 索引,模型挑感兴趣的再细查
 *  - 传 key   → 返回单条 {key, title, oneLiner, detail}
 *  - key 不存在 → 返回可用 key 列表 + UNKNOWN_KEY 错误码,让模型自纠
 *  - scope=help → 宿主注入的产品帮助文档(与设置页帮助助手同一份):不传 key 返回目录,
 *    传 key 返回整篇。回答「X 在哪 / 怎么操作」这类界面问题用。
 *
 * 故意不支持批量 keys:简单优先,模型多调几次成本极低,且分次拉取也省 token。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import { findCapability, listCapabilityIndex } from './capabilities.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

export interface RuntimeCapabilityQuery { server?: string; category?: string; toolQuery?: string; offset?: number; }
export type RuntimeCapabilityReader = (query: RuntimeCapabilityQuery) => Promise<unknown>;
export interface ProductHelpDoc { id: string; title: string; summary: string; content: string; }

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function readProductHelp(docs: readonly ProductHelpDoc[] | undefined, key: string | undefined) {
  if (!docs?.length) return textResult({ ok: false, errorCode: 'HELP_UNAVAILABLE', message: '当前宿主未提供产品帮助文档。' }, true);
  if (!key) {
    return textResult({
      ok: true,
      docs: docs.map(({ id, title, summary }) => ({ key: id, title, summary })),
      hint: '挑相关的一篇用 get_capabilities({scope:"help", key}) 读全文。',
    });
  }
  const doc = docs.find((d) => d.id === key);
  if (!doc) {
    return textResult({ ok: false, errorCode: 'UNKNOWN_KEY', data: { requested: key, available: docs.map((d) => d.id) } }, true);
  }
  return textResult({
    ok: true,
    doc: { key: doc.id, title: doc.title, content: doc.content },
    hint: '文档按英文界面撰写；用其他语言回答时说出该语言界面上的对应文字，拿不准译名就附英文原名。文档没写到的入口直说不确定，不要推测。',
  });
}

export function registerGetCapabilitiesTool(
  registry: XdtHelperToolRegistry,
  readRuntime?: RuntimeCapabilityReader,
  helpDocs?: readonly ProductHelpDoc[],
): void {
  registry.register({
    name: 'get_capabilities',
    category: 'cindy',
    description:
      `查询 ${BRAND_NAME} 自身能力。不传参数 → 返回所有能力的 {key, title, oneLiner} 索引;` +
      '传 key=<具体能力 key> → 返回该能力的完整 detail。scope=runtime 查询当前 Agent 的真实工具目录；指定 server 查看注册工具，category 展开内置类目。产品说明不等于可调用工具。' +
      `当用户问"${BRAND_NAME} 能做什么 / 有哪些功能 / 支持 X 吗"时调用本工具,而不是用训练数据回答。` +
      `用户问"你是谁 / 你是什么 / 你跑在哪 / ${BRAND_NAME} 是什么产品 / 谁做的 / 开不开源 / 源码在哪"时,` +
      '同样调本工具取 key=about-cindy,不要靠工作目录路径、工具名或训练数据推断。' +
      `用户问"某功能在哪 / 界面上怎么操作 / 找不到某个入口"时,用 scope=help 先看帮助文档目录,再传 key 读对应篇,按文档回答。`,
    inputShape: {
      scope: z.enum(['product', 'runtime', 'help']).optional().describe('product 查询产品介绍；runtime 查询实际注册与启用状态；help 查询界面入口与操作步骤的帮助文档。'),
      server: z.string().optional().describe('从 runtime 目录返回的 server 标识。'),
      category: z.string().optional().describe('该 server 的 list_tools 返回的类目。'),
      toolQuery: z.string().trim().max(200).optional().describe('引擎管理的 MCP 工具按名称或说明筛选；每页最多 50 项。'),
      offset: z.number().int().min(0).max(100_000).optional().describe('引擎工具目录的分页起点，沿用同一 server 和 toolQuery，传上页 nextOffset。'),
      key: z
        .string()
        .optional()
        .describe('能力 key 或帮助文档 key(从不传 key 的目录返回中获取)。不传 = 返回目录。'),
    },
    handler: async ({ key, scope, server, category, toolQuery, offset }) => {
      if (scope === 'runtime') {
        const result = readRuntime ? await readRuntime({ server, category, ...(toolQuery !== undefined ? { toolQuery } : {}), ...(offset !== undefined ? { offset } : {}) })
          : { ok: false, errorCode: 'RUNTIME_CATALOG_UNAVAILABLE', message: '当前宿主尚未提供运行能力目录。' };
        return textResult(result);
      }
      if (scope === 'help') return readProductHelp(helpDocs, key);
      if (!key) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                capabilities: listCapabilityIndex(),
                hint: '挑感兴趣的能力用 get_capabilities({key}) 取 detail。',
              }),
            },
          ],
        };
      }

      const entry = findCapability(key);
      if (!entry) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                errorCode: 'UNKNOWN_KEY',
                data: {
                  requested: key,
                  available: listCapabilityIndex().map((c) => c.key),
                  hint: '请用 available 列表里的 key 重试。',
                },
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              capability: entry,
            }),
          },
        ],
      };
    },
  });
}
