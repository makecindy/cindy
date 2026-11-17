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
    ['timeout 60 pnpm dev', 'work'],
    // 超出简单结构的 shell 语法一律不猜，整条命令按工作（不变量 5）
    // 后台 &：命令的存活另有安排，kill / wait 都无从静态判断
    ['pnpm dev & server=$!; pnpm test; kill "$server"', 'work'],
    ['pnpm dev & server=$!; pnpm test & tests=$!; wait "$tests"; kill "$server"', 'work'],
    ['nohup pnpm dev > dev.log 2>&1 & pnpm test', 'work'],
    ['pnpm dev &', 'work'],
    ['pnpm dev | tee dev.log & pnpm test', 'work'],
    ['pnpm dev > dev.log 2>&1 & wait', 'work'],
    // 注释：其后的分号和命令都不会执行
    ['pnpm test # Run tests; pnpm dev is not started', 'work'],
    // 控制流和命令组
    ['if false; then\npnpm dev\nfi\npnpm test', 'work'],
    ['while true; do pnpm dev; done', 'work'],
    ['for p in a b; do pnpm --filter $p dev; done', 'work'],
    ['(cd apps/web && pnpm dev)', 'work'],
    ['pnpm test && { pnpm dev; }', 'work'],
    // heredoc：正文是数据，不是命令，也不去猜它之后的命令
    ["cat <<'EOF' > /tmp/example-script\npnpm dev\nEOF\npnpm test", 'work'],
    ['cat <<-EOF > run.sh\n\tpnpm dev\n\tEOF\npnpm test', 'work'],
    ['cat <<EOF > run.sh\necho hi\nEOF\npnpm dev', 'work'],
    ['cat <<< "pnpm dev"', 'work'],
    // 不认识的外层命令不让内层参数直接决定结果：timeout 给了期限，按工作
    ['timeout -k 5s 60s pnpm vitest --watch', 'work'],
    ['nice -n 10 pnpm vitest --watch', 'work'],
    ['echo --watch', 'work'],
    ['npm install --include=dev', 'work'],
    ['pnpm --filter dev test', 'work'],
    ['pnpm vitest --watch=0 --no-watch', 'work'],
    ['until curl -sf localhost:3000; do sleep 2; done', 'work'],
    ['', 'work'],
    [undefined, 'work'],
    // 启动后不会自己结束：服务
    ['pnpm dev', 'service'],
    ['pnpm --filter desktop dev', 'service'],
    // 顺序执行卡在第一个不会结束的段；管道有一段不结束就不结束；重定向里的 & 不是后台
    ['pnpm test && pnpm dev', 'service'],
    ['pnpm dev | tee dev.log', 'service'],
    ['pnpm dev > dev.log 2>&1', 'service'],
    ['pnpm dev 2>&1', 'service'],
    ['pnpm -C apps/web dev', 'service'],
    ['npm run dev -w web', 'service'],
    ['cd apps/web && npm start', 'service'],
    ['PORT=4000 yarn workspace web dev:local', 'service'],
    ['pnpm exec vite --port 5173', 'service'],
    ['npx --yes serve dist', 'service'],
    ['bash -lc "cd site && pnpm build && pnpm preview"', 'service'],
    ['pnpm vitest --watch', 'service'],
    ['vitest --watch', 'service'],
    ['pnpm exec vitest --watch', 'service'],
    ['npm test -- --watch', 'service'],
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
