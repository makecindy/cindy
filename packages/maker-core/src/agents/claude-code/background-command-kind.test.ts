/**
 * 测试价值
 * - 生产入口与可观察结果：classifyBackgroundCommand；结果决定任务列表把一条后台命令显示为
 *   「运行中」（工作）还是不显示（长驻服务）。
 * - 规则依据：docs/dev-rules/maker-core-and-agent-behavior.md「后台命令：工作与服务」。
 * - 现有覆盖缺口：abort-stops-background-tasks.test.ts 只验证种类随事件下发，不覆盖命令写法矩阵。
 * - 最小失败输入：见下表；每行是一种不同的写法分支（脚本名、包装前缀、子命令、反例）。
 * - tier：unit，纯函数；与 3000 行的 SDK mock 文件环境不同，故单独成文件。
 */
import { describe, expect, it } from 'vitest';

import { classifyBackgroundCommand } from './background-command-kind.js';

describe('classifyBackgroundCommand', () => {
  it.each([
    // 会自己结束：工作
    ['pnpm test:unit:related', 'work'],
    ['pnpm --filter desktop typecheck && pnpm --filter desktop test', 'work'],
    ['npm run build', 'work'],
    ['npx vite build', 'work'],
    ['docker compose up -d', 'work'],
    ['tail -n 50 build.log', 'work'],
    ['pnpm restart:desktop:remote -- --isolated=@worktree', 'work'],
    ['npm run build:preview', 'work'],
    ['pnpm --filter desktop test --watch=false', 'work'],
    // 选项取值和包管理子命令不是脚本名：`--include dev` 是依赖类型，`--filter dev` 是包名
    ['npm ci --include dev', 'work'],
    ['npm install --include=dev', 'work'],
    ['pnpm --filter dev test', 'work'],
    ['pnpm vitest --watch=0 --no-watch', 'work'],
    ['until curl -sf localhost:3000; do sleep 2; done', 'work'],
    ['', 'work'],
    [undefined, 'work'],
    // 启动后不会自己结束：服务
    ['pnpm dev', 'service'],
    ['pnpm --filter desktop dev', 'service'],
    ['pnpm -C apps/web dev', 'service'],
    ['npm run dev -w web', 'service'],
    ['cd apps/web && npm start', 'service'],
    ['PORT=4000 yarn workspace web dev:local', 'service'],
    ['pnpm exec vite --port 5173', 'service'],
    ['npx --yes serve dist', 'service'],
    ['bash -lc "cd site && pnpm build && pnpm preview"', 'service'],
    ['pnpm vitest --watch', 'service'],
    ['pnpm vitest --watch=true', 'service'],
    ['pnpm build:watch', 'service'],
    ['python3 -m http.server 8000', 'service'],
    ['next dev -p 3001', 'service'],
    ['docker compose up', 'service'],
    ['tail -f logs/app.log', 'service'],
  ] as const)('%s → %s', (command, kind) => {
    expect(classifyBackgroundCommand(command)).toBe(kind);
  });
});
