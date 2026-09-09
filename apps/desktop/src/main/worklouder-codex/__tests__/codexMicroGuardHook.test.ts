import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const hookSourcePath = path.resolve(__dirname, '../codexMicroGuardHook.cjs');
const SERVICE_SOURCE = `
// HID topology watcher addon not found
// @worklouder/device-kit-oai
// exports.CodexMicroService=
// getState(){
// start(){
// async updateLighting(
// async stop(){
// dispose(){
throw new Error('real hardware service evaluated');
`;

interface Fixture {
  root: string;
  support: string;
  build: string;
  hook: string;
  productionHook: string;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-hook-'));
  roots.push(root);
  const support = path.join(root, 'support');
  const build = path.join(
    root,
    'Applications',
    'ChatGPT.app',
    'Contents',
    'Resources',
    'app.asar',
    '.vite',
    'build',
  );
  fs.mkdirSync(support, { recursive: true, mode: 0o700 });
  fs.mkdirSync(build, { recursive: true });
  const source = fs.readFileSync(hookSourcePath, 'utf8');
  const productionHook = path.join(support, 'production-hook.cjs');
  fs.writeFileSync(productionHook, source, { mode: 0o600 });
  const transformed = source.replace(
    /function runtimeScope\(\) \{[\s\S]*?\n\}/u,
    `function runtimeScope() { return ${JSON.stringify(fs.realpathSync(build))}; }`,
  );
  const hook = path.join(support, 'guard-hook.cjs');
  fs.writeFileSync(hook, transformed, { mode: 0o600 });
  fs.writeFileSync(path.join(support, 'enabled'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(support, 'heartbeat'), JSON.stringify(Date.now() / 1_000), {
    mode: 0o600,
  });
  return { root, support, build, hook, productionHook };
}

function run(
  value: Fixture,
  serviceSource: string,
  mainName = 'main-fixture.js',
): ReturnType<typeof spawnSync> {
  const main = path.join(value.build, mainName);
  const service = path.join(value.build, 'service-fixture.js');
  fs.writeFileSync(
    main,
    "const { CodexMicroService } = require('./service-fixture.js');\n" +
      'const service = new CodexMicroService({});\n' +
      'service.start();\nprocess.stdout.write(JSON.stringify(service.getState()));\n',
  );
  fs.writeFileSync(service, serviceSource);
  return spawnSync(process.execPath, ['--require', value.hook, main], {
    encoding: 'utf8',
    env: process.env,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Codex Micro preload guard', () => {
  it('ships without a test-mode escape and validates private stable files', () => {
    const source = fs.readFileSync(hookSourcePath, 'utf8');
    expect(source).not.toMatch(/CODEX_MICRO_GUARD_TEST/u);
    expect(source).toMatch(/O_NOFOLLOW/u);
    expect(source).toMatch(/captureSupportChain/u);
    expect(source).toMatch(/assertSupportChainStable/u);
    expect(source).not.toMatch(/process\.platform !== 'win32'/u);
    expect(source).toMatch(/HID topology watcher addon not found/u);
    expect(source).toMatch(/@worklouder\/device-kit-oai/u);
  });

  it.skipIf(process.platform === 'win32')(
    'intercepts only the marked service under a main bundle parent',
    () => {
      const value = fixture();
      const result = run(value, SERVICE_SOURCE);
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout))).toEqual({
        status: 'unavailable',
        controlPlaneStatus: 'unavailable',
        transport: null,
        model: null,
        error: null,
        battery: null,
      });
      const receiptPath = path.join(value.support, 'receipt.json');
      expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).service).toBe(
        'service-fixture.js',
      );
      expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    },
  );

  it.each([
    [
      'stale heartbeat',
      (value: Fixture) =>
        fs.writeFileSync(
          path.join(value.support, 'heartbeat'),
          JSON.stringify(Date.now() / 1_000 - 16),
          { mode: 0o600 },
        ),
    ],
    [
      'missing enabled marker',
      (value: Fixture) => fs.unlinkSync(path.join(value.support, 'enabled')),
    ],
    ['public marker', (value: Fixture) => fs.chmodSync(path.join(value.support, 'enabled'), 0o644)],
  ])('fails open for a %s', (_name, mutate) => {
    const value = fixture();
    mutate(value);
    const result = run(value, SERVICE_SOURCE);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('real hardware service evaluated');
  });

  it('fails open for missing service markers and a non-main parent', () => {
    const value = fixture();
    expect(
      run(
        value,
        '// HID topology watcher addon not found\n// @worklouder/device-kit-oai\n' +
          "throw new Error('real hardware service evaluated');\n",
      ).status,
    ).toBe(1);
    expect(run(value, SERVICE_SOURCE, 'renderer-fixture.js').status).toBe(1);
  });

  it('does not affect an ordinary Node process with the shipped production scope', () => {
    const value = fixture();
    const main = path.join(value.build, 'main-fixture.js');
    const service = path.join(value.build, 'service-fixture.js');
    fs.writeFileSync(main, "require('./service-fixture.js');\n");
    fs.writeFileSync(service, SERVICE_SOURCE);
    const result = spawnSync(process.execPath, ['--require', value.productionHook, main], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('real hardware service evaluated');
  });
});
