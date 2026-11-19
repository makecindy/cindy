import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { okPayload } from './_payload.js';

const memoryRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('search'), query: z.string().max(200).optional() }),
  z.object({ action: z.literal('read'), filename: z.string().min(1).max(128) }),
  z.object({ action: z.literal('remember'), name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    title: z.string().min(1).max(80), body: z.string().min(1).max(4000), ownerRequest: z.string().trim().min(1).max(1000) }),
]);
export type ProjectCompanionMemoryCallback = (context: LiziMcpSessionContext, request: z.infer<typeof memoryRequest>) => Promise<unknown>;

export function registerProjectCompanionMemory(registry: XdtHelperToolRegistry, call: ProjectCompanionMemoryCallback,
  context: () => LiziMcpSessionContext) {
  registry.register({
    name: 'project_companion_memory', category: 'bots',
    description: '当前项目任务所选对话伙伴的笔记。search 按需搜索（省略 query 可列出），read 按 filename 读取。仅在主人明确要求跨项目记住偏好时使用 remember，ownerRequest 填本轮用户表达该意愿的原话。项目内的决定使用项目记忆。',
    inputShape: { request: memoryRequest },
    handler: async ({ request }) => okPayload({ result: await call(context(), request) }),
  });
}
