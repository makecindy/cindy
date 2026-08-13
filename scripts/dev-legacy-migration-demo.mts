/**
 * dev-legacy-migration-demo — 本地体验「存量插件升级无感迁移」(docs §5 红线)。
 *
 * 为什么存在:插件运行授权改由 Host receipt 持有(#636 修复)后,升级前装的插件没有
 * receipt。本脚本用**真实的 `GhostManager` 生产代码**,在一个临时目录里造出「旧布局
 * 已装插件」(#1080 之前的形态:ghost.json / .cindy-trust.json / .disabled,没有 receipt),
 * 跑一次迁移,把迁移前后的 `list()` 打出来,让你亲眼看到:
 *   迁移前 = 全部 legacy-unapproved、停用(这正是被回滚的故障现场)
 *   迁移后 = 用户什么都没做,插件照旧 approved、启用态被保留、技能链可挂
 * 全程在 os.tmpdir 里进行,**不触碰你的真实插件与数据**。
 *
 * 运行:
 *   node_modules/.bin/tsx scripts/dev-legacy-migration-demo.mts
 *   (或 pnpm demo:legacy-migration)
 *
 * 想在**真实 app** 里眼见为实,见文件末尾打印的「在真实 app 中体验」步骤。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GhostManager } from '../apps/desktop/src/main/cindy-brain/GhostManager.ts';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: id,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['tool'],
    tools: [{ name: 'do_thing', description: 'demo' }],
    ...extra,
  };
}

/** 造一份 #1080 之前的旧布局安装:只写安装目录三文件,不写任何 receipt。 */
async function plantLegacyInstall(
  root: string,
  id: string,
  m: Record<string, unknown>,
  opts: { disabled?: boolean; trust?: Record<string, unknown>; files?: Record<string, string> } = {},
): Promise<void> {
  const dir = path.join(root, id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'ghost.json'), JSON.stringify(m, null, 2));
  await fs.promises.writeFile(path.join(dir, 'main.js'), 'console.log("legacy demo")');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(dir, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  if (opts.disabled) await fs.promises.writeFile(path.join(dir, '.disabled'), '');
  await fs.promises.writeFile(
    path.join(dir, '.cindy-trust.json'),
    JSON.stringify(
      opts.trust ?? {
        level: 'unverified',
        publisherSigned: false,
        publisherVerified: false,
        reviewed: false,
      },
    ),
  );
}

function printList(label: string, manager: GhostManager): void {
  console.log(`\n${BOLD}${label}${RESET}`);
  for (const g of manager.list()) {
    const ok = g.approval.state === 'approved' && g.enabled;
    const color = ok ? GREEN : YELLOW;
    console.log(
      `  ${color}${g.manifest.id.padEnd(16)}${RESET} ` +
        `approval=${g.approval.state.padEnd(18)} ` +
        `enabled=${String(g.enabled).padEnd(6)} ` +
        `trust=${g.trust?.level ?? '-'}`,
    );
  }
}

async function main(): Promise<void> {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-legacy-migration-demo-'));
  const installRoot = path.join(workDir, 'cindy-brain');
  const stateRoot = path.join(workDir, 'ghost-install-state');
  await fs.promises.mkdir(installRoot, { recursive: true });

  console.log(`${DIM}临时安装根: ${installRoot}${RESET}`);
  console.log(`${DIM}临时状态根: ${stateRoot}${RESET}`);

  // 三种典型的旧布局安装(市场/本地包场景 —— 随包内置插件走 provisioning,不在此列)。
  await plantLegacyInstall(installRoot, 'market-plugin', manifest('market-plugin'), {
    trust: {
      level: 'verified-publisher',
      publisherSigned: true,
      publisherVerified: true,
      reviewed: false,
      publisherName: 'Acme',
    },
  });
  await plantLegacyInstall(installRoot, 'user-disabled', manifest('user-disabled'), {
    disabled: true, // 用户之前手动停用过 —— 迁移必须保留这个决定
  });
  await plantLegacyInstall(
    installRoot,
    'skill-plugin',
    manifest('skill-plugin', {
      slots: ['tool', 'skill'],
      skill: { items: [{ dir: 'skills/demo', name: 'demo', description: 'Demo skill' }] },
    }),
    { files: { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n\ndemo\n' } },
  );

  const manager = new GhostManager({
    getRootDir: () => installRoot,
    getStateDir: () => stateRoot,
    getLocale: () => 'zh-CN',
    // 生产接线用 isTrustedBundledId 把随包种子挡在迁移之外;demo 里没有随包种子。
  });

  printList('迁移前(升级刚发生,还没有任何 receipt —— 这就是 #1080 被回滚时用户看到的):', manager);
  console.log(`${DIM}  ↑ 全部 legacy-unapproved + 停用:开关点不动、要用户逐个重新确认。${RESET}`);

  const outcome = await manager.migrateLegacyApprovalsOnce();
  console.log(
    `\n${BOLD}迁移结果${RESET}: migrated=[${outcome.migrated.join(', ')}] ` +
      `skipped=[${outcome.skipped.join(', ')}] failed=[${outcome.failed.join(', ')}]`,
  );

  printList('迁移后(用户什么都没做):', manager);
  console.log(
    `${DIM}  ↑ market-plugin 恢复启用且保留 verified-publisher;user-disabled 保留停用;` +
      `skill-plugin 启用且快照已建。${RESET}`,
  );

  // 技能快照字节指纹校验(对账挂链的前置):迁移出的快照能被认可 = 技能链不会断。
  const skill = manager.list().find((g) => g.manifest.id === 'skill-plugin');
  if (skill) {
    const ok = await manager.verifyApprovedSkillSnapshot(skill);
    console.log(`\n技能快照校验 verifyApprovedSkillSnapshot(skill-plugin) = ${ok ? GREEN : YELLOW}${ok}${RESET}`);
  }

  const ledgerPath = path.join(stateRoot, '.legacy-migration.json');
  console.log(`\n${BOLD}迁移台账${RESET} ${DIM}${ledgerPath}${RESET}`);
  console.log(fs.readFileSync(ledgerPath, 'utf8').trimEnd());

  // 全局一次性门:台账落地后,再冒出一个没有 receipt 的目录不会被迁移(fail closed)。
  // 这道门挡住"删掉 receipt 骗一次从可变安装目录重建授权"。
  await plantLegacyInstall(installRoot, 'planted-after', manifest('planted-after'));
  const second = await manager.migrateLegacyApprovalsOnce();
  const planted = manager.list().find((g) => g.manifest.id === 'planted-after');
  console.log(
    `\n${BOLD}一次性门验证${RESET}: 台账已在 → 再次迁移 migrated=[${second.migrated.join(', ')}] ` +
      `(应为空);planted-after 状态 = ${planted?.approval.state} (应为 legacy-unapproved)`,
  );

  // 回滚余地:迁移只写状态根,安装目录三文件原样保留 —— 回滚到旧客户端仍可用。
  const marketGhostJson = fs.readFileSync(path.join(installRoot, 'market-plugin', 'ghost.json'), 'utf8');
  console.log(
    `\n${BOLD}回滚余地${RESET}: 安装目录 ghost.json 未被迁移改动 = ${
      marketGhostJson.includes('"market-plugin"') ? `${GREEN}true${RESET}` : `${YELLOW}false${RESET}`
    } (旧客户端回滚后仍从安装目录判定,不错位)`,
  );

  await fs.promises.rm(workDir, { recursive: true, force: true });

  console.log(
    `\n${BOLD}在真实 app 中体验(可选,眼见 UI):${RESET}\n` +
      `  1. 用当前构建装一个市场插件或本地 .cindy,确认它可用;\n` +
      `  2. 退出 app;\n` +
      `  3. 到 owner-scoped 状态根 <userData>/owners/<你的 ownerKey>/ghost-install-state/,\n` +
      `     删掉该插件的 <id>.json 与 .legacy-migration.json(模拟"从没有 receipt 的旧版本升上来");\n` +
      `     (Windows: %APPDATA%\\Cindy\\owners\\...  macOS: ~/Library/Application Support/Cindy/owners/...)\n` +
      `  4. 重新启动 app —— 插件应当照旧可用,不出现"需要重新确认权限",不用你做任何操作。\n` +
      `  ${DIM}删 receipt 是安全的:安装目录与你的配置/凭证都不动,下次启动迁移会重建 receipt。${RESET}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
