/**
 * xdt-helper/get_capabilities.ts — get_capabilities tool
 *
 * 渐进式发现:
 *  - 不传 key  → 返回全部 {key, title, oneLiner} 索引,模型挑感兴趣的再细查
 *  - 传 key   → 返回单条 {key, title, oneLiner, detail}
 *  - key 不存在 → 返回可用 key 列表 + UNKNOWN_KEY 错误码,让模型自纠
 *
 * 故意不支持批量 keys:简单优先,模型多调几次成本极低,且分次拉取也省 token。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import { findCapability, listCapabilityIndex } from './capabilities.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';

export interface RuntimeCapabilityQuery { server?: string; category?: string; }
export type RuntimeCapabilityReader = (query: RuntimeCapabilityQuery) => Promise<unknown>;

export function registerGetCapabilitiesTool(registry: XdtHelperToolRegistry, readRuntime?: RuntimeCapabilityReader): void {
  registry.register({
    name: 'get_capabilities',
    category: 'cindy',
    description:
      `查询 ${BRAND_NAME} 自身能力。不传参数 → 返回所有能力的 {key, title, oneLiner} 索引;` +
      '传 key=<具体能力 key> → 返回该能力的完整 detail。scope=runtime 查询当前 Agent 的真实工具目录；指定 server 查看注册工具，category 展开内置类目。产品说明不等于可调用工具。' +
      `当用户问"${BRAND_NAME} 能做什么 / 有哪些功能 / 支持 X 吗"时调用本工具,而不是用训练数据回答。` +
      `用户问"你是谁 / 你是什么 / 你跑在哪 / ${BRAND_NAME} 是什么产品 / 谁做的 / 开不开源 / 源码在哪"时,` +
      '同样调本工具取 key=about-cindy,不要靠工作目录路径、工具名或训练数据推断。',
    inputShape: {
      scope: z.enum(['product', 'runtime']).optional().describe('product 查询产品介绍；runtime 查询实际注册与启用状态。'),
      server: z.string().optional().describe('从 runtime 目录返回的 server 标识。'),
      category: z.string().optional().describe('该 server 的 list_tools 返回的类目。'),
      key: z
        .string()
        .optional()
        .describe('能力 key(从不传参的索引返回中获取)。不传 = 返回索引列表。'),
    },
    handler: async ({ key, scope, server, category }) => {
      if (scope === 'runtime') {
        const result = readRuntime ? await readRuntime({ server, category })
          : { ok: false, errorCode: 'RUNTIME_CATALOG_UNAVAILABLE', message: '当前宿主尚未提供运行能力目录。' };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      }
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
