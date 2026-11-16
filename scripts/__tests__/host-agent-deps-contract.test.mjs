/*
 * 测试价值
 * - 规则依据：Host 交给 maker-core 引擎与 Maker 的依赖必须用 maker-core 读取的键名。
 *   Host 曾把 Pi 的 MCP 桥写成 `prepareMcpBridge`（AgentDeps 里没有），当时 runtime 还是没有类型检查的 JS，
 *   Host 上的 Pi 任务因此没有进程内 MCP。失效后果：写错的依赖被静默忽略，任务照常跑但缺能力。
 *   apps/host/src/agent/runtime.ts 现在受类型检查，对象字面量里的多余键由 tsc 拦下；展开进来的依赖包
 *   不做多余键检查，所以本守护继续要求每个展开都来自登记过的 TS 类型化依赖包。
 * - 为什么是静态检查：键名对不对只能对照 maker-core 的类型声明；经生产入口的行为测试见
 *   apps/host/src/agent/agent-graph.test.mjs，它只覆盖 Pi 的桥。
 * - 最小失败输入：任一引擎构造参数里出现 AgentDeps 没有的键，或展开了一个不是 TS 类型化依赖包的对象。
 * - tier：guard（跨包源码约定，登记在 check-test-hygiene.mjs 的 ROOT_SOURCE_CONTRACTS，由 test:runner 执行）。
 *   单独成文件：源码约定只能放在登记过的文件里，现有登记文件都不涉及 Host。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ts = createRequire(path.join(root, 'apps/desktop/package.json'))('typescript');

function parse(rel) {
  const file = path.join(root, rel);
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
}

function interfaceMembers(rel, name) {
  const members = new Set();
  const visit = node => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const member of node.members) if (member.name) members.add(member.name.getText());
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(rel));
  assert.ok(members.size > 0, `${name} not found in ${rel}`);
  return members;
}

/** Literal keys of `new <ctor>({...})`, following `...(cond ? {...} : {})`; other spreads are reported. */
function constructorKeys(sf, ctor) {
  const found = [];
  const visit = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ctor
      && node.arguments?.[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      const keys = [];
      const spreads = [];
      const collect = (object) => {
        for (const property of object.properties) {
          if (!ts.isSpreadAssignment(property)) { keys.push(property.name.getText(sf)); continue; }
          let expression = property.expression;
          while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
          if (ts.isConditionalExpression(expression)) {
            for (const branch of [expression.whenTrue, expression.whenFalse]) {
              if (ts.isObjectLiteralExpression(branch)) collect(branch);
              else spreads.push(branch.getText(sf));
            }
          } else {
            spreads.push(expression.getText(sf));
          }
        }
      };
      collect(node.arguments[0]);
      found.push({ keys, spreads });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.equal(found.length, 1, `expected one new ${ctor}({...}) in runtime.ts`);
  return found[0];
}

// The spread bundles are built in TypeScript as Pick/Partial<AgentDeps>, so their keys are type checked there.
// The per-model resolver bundles come from engineModelResolvers.ts, typed as Required<Pick<AgentDeps, ...>>.
const TYPED_SPREADS = new Set(['options.mcpRuntime.codexDeps', 'options.codexRuntime?.deps', 'options.mcpRuntime.piDeps',
  'claudeModelResolvers', 'codexModelResolvers', 'piModelResolvers']);

test('every key the Host hands an engine or Maker exists in the maker-core dependency types', () => {
  const runtime = parse('apps/host/src/agent/runtime.ts');
  const agentDeps = interfaceMembers('packages/maker-core/src/agents/base-agent.ts', 'AgentDeps');
  const makerDeps = interfaceMembers('packages/maker-core/src/maker.ts', 'MakerDeps');
  for (const [ctor, allowed] of [['ClaudeCodeAgent', agentDeps], ['CodexAgent', agentDeps], ['PiAgent', agentDeps], ['Maker', makerDeps]]) {
    const { keys, spreads } = constructorKeys(runtime, ctor);
    assert.deepEqual(keys.filter(key => !allowed.has(key)), [], `${ctor} receives keys maker-core never reads`);
    assert.deepEqual(spreads.filter(spread => !TYPED_SPREADS.has(spread)), [], `${ctor} spreads an untyped bundle`);
  }
});

