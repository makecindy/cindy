import assert from "node:assert/strict";
import test from "node:test";

import { isUiPath, validateDesignBasis } from "../check-pr-design-basis.mjs";

const UI_FILES = ["apps/desktop/src/renderer/components/login/LoginControls.tsx"];
const body = (basis) => `### UI 变化\n\n- 引用的设计规范：${basis}\n\n## 怎么验证的\n`;
const passes = (basis) => validateDesignBasis(body(basis), UI_FILES).length === 0;

test("现行设计文档的引用仍算有设计依据", () => {
	assert.equal(passes("DESIGN.md §16.1 登录调色板：文字走墨水阶梯"), true);
	assert.equal(passes("docs/design-rules/token-decision-table.md §3 色值决策"), true);
	assert.equal(passes("docs/design-rules/cindy-design-system.md 索引"), true);
});

test("只引用已删除的 figma-component-spec，不论哪种写法都不算设计依据", () => {
	assert.equal(passes("figma-component-spec §4 组件逐参数规格"), false);
	assert.equal(passes("docs/design-rules/figma-component-spec.md §4"), false);
	assert.equal(passes("[规格](docs/design-rules/figma-component-spec.md)"), false);
	assert.equal(passes("Figma-Component-Spec §12"), false);
});

test("同时引用现行文档时，顺带提到已删除文档不影响通过", () => {
	assert.equal(passes("DESIGN.md §16.5；旧 figma-component-spec §11 已迁入"), true);
});

test("与已删除文档无空格连写的现行引用不会被连带剔除", () => {
	assert.equal(passes("[现行](docs/design-rules/DESIGN.md)；[旧](docs/design-rules/figma-component-spec.md)"), true);
	assert.equal(passes("DESIGN.md§16；figma-component-spec.md§4"), true);
	assert.equal(passes("[旧](docs/design-rules/figma-component-spec.md)；[现行](docs/design-rules/token-decision-table.md)"), true);
});

test("Mobile 文字规范与其它现行设计文档按确切文件名算设计依据", () => {
	assert.equal(passes("apps/mobile/docs/mobile-design-guide.md §3 文字规范速查：caption 行"), true);
	assert.equal(passes("mobile-design-guide §5 圆角阶梯"), true);
	assert.equal(passes("ios-native-design.md 系统 sheet"), true);
	assert.equal(passes("design-governance.md §8 门禁接线"), true);
});

test("任意 *-design.md 或小写 design.md 不再误算设计依据", () => {
	assert.equal(passes("feature-design.md"), false);
	assert.equal(passes("见 design.md"), false);
	assert.equal(passes("MY-DESIGN.md"), false);
});

test("Mobile src 下所有界面文件都算 UI 路径", () => {
	for (const file of [
		"apps/mobile/src/plugins/PluginDetailView.tsx",
		"apps/mobile/src/remote-desktop/RemoteDesktopControls.tsx",
		"apps/mobile/src/inputHandoff/InputHandoffSheet.ios.tsx",
		"apps/mobile/src/session/ContextSheet.tsx",
	]) assert.equal(isUiPath(file), true, file);
	for (const file of ["apps/mobile/src/device-link/client.ts", "apps/mobile/app.config.js", "packages/maker-shared/src/x.tsx"]) {
		assert.equal(isUiPath(file), false, file);
	}
});

test("检查名称、workflow 与脚本入口一致（design-governance.md §8.2）", async () => {
	const { readFileSync, existsSync } = await import("node:fs");
	const workflow = readFileSync(new URL("../../.github/workflows/pr-design-basis.yml", import.meta.url), "utf8");
	assert.match(workflow, /^\s+name: check:pr-design-basis$/m);
	assert.match(workflow, /^\s+run: node scripts\/check-pr-design-basis\.mjs$/m);
	assert.ok(existsSync(new URL("../check-pr-design-basis.mjs", import.meta.url)));
});

test("近似文件名（带后缀、前缀或不同扩展名）不算设计依据", () => {
	for (const basis of [
		"mobile-design-guide-draft.md",
		"my-ios-native-design.md",
		"myios-native-design-copy.md",
		"design-governance-notes.md",
		"not-design-governance-anymore.txt",
		"token-decision-table2.md",
		"DESIGN.md.bak",
	]) assert.equal(passes(basis), false, basis);
	for (const basis of ["mobile-design-guide", "mobile-design-guide.md §3", "[指南](apps/mobile/docs/mobile-design-guide.md)", "见 design-governance §8；DESIGN.md§5"]) {
		assert.equal(passes(basis), true, basis);
	}
});
