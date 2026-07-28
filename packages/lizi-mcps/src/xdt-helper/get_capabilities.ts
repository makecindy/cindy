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

export function registerGetCapabilitiesTool(registry: XdtHelperToolRegistry): void {
  registry.register({
    name: 'get_capabilities',
    category: 'cindy',
    description:
      `查询 ${BRAND_NAME} 自身能力。不传参数 → 返回所有能力的 {key, title, oneLiner} 索引;` +
      '传 key=<具体能力 key> → 返回该能力的完整 detail。' +
      `当用户问"${BRAND_NAME} 能做什么 / 有哪些功能 / 支持 X 吗"时调用本工具,而不是用训练数据回答。` +
      `用户问"你是谁 / 你是什么 / 你跑在哪 / ${BRAND_NAME} 是什么产品 / 谁做的 / 开不开源 / 源码在哪"时,` +
      '同样调本工具取 key=about-cindy,不要靠工作目录路径、工具名或训练数据推断。',
    inputShape: {
      key: z
        .string()
        .optional()
        .describe('能力 key(从不传参的索引返回中获取)。不传 = 返回索引列表。'),
    },
    handler: async ({ key }) => {
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
