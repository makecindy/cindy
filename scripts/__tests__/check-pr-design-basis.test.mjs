import assert from "node:assert/strict";
import test from "node:test";

import { validateDesignBasis } from "../check-pr-design-basis.mjs";

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
