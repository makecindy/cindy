# 文档美观线 5/6/7 · 改动清单与测试证据

工作树：`/Users/chris/Code/Github/cindy-docs-toolkit`（PR #3049 分支 `cindy-docs-toolkit`）
未 commit、未 push、未启动 dev/Electron。

## 5. PPT 母版版式系统

根因：`make_pptx` 只有 light/dark 两套色，所有页共用「标题 + 短线 + 要点」单版式，没有封面/分节、没有页脚页码，母版 API 完全没用上。

改动：

- 新增 `themes.ts`：`light` / `dark` / `navy` 纯配置色板（6 位 hex，不捆图不捆字体）
- 新增 `pptxMasters.ts`：`CINDY_COVER` / `CINDY_SECTION` / `CINDY_CONTENT` 三套 pptxgenjs 母版 + 槽位几何
- `make_pptx` 新参数：`slides[].layout`（cover/section/content，默认 content）、`slides[].subtitle`、`theme` 增加 `navy`、`footer`（默认 true）
- 封面无页码；分节/内容页母版登记页脚标签（用 deck `title`）和 `slideNumber`
- 有图时仍收窄左栏，坐标改走 `layoutSlots`，不再手写魔法数

测试证据：

- `cindyDocsDefaults.test.ts`：三套版式名写入 slideLayout、封面 40pt、navy 强调色、页脚标签、`type="slidenum"`；`footer:false` 时版式里没有 slidenum 字段
- `cindyDocsMcpServer.test.ts` 既有 PPT 往返（标题/要点/备注/深浅底色/坏图拦截）仍绿
- 合计当时 52 个相关用例通过

## 6. Word / Excel / PDF 好默认值下沉

根因：不装插件时，Word 标题是库默认蓝、无封面、表头只有浅灰；Excel 表头浅灰无斑马纹无数字格式；`render_pdf` 对裸 HTML 原样打印，出来像未排版网页。

改动：

- Word：`docxStyles.ts` 定义 H1–H6 / Title 字号色；给了 `title` 默认独立封面（`cover`/`subtitle`/`theme`）；表格强调色表头 + 斑马纹 + 细边框；正文节右对齐页码
- Excel：`theme` + `zebra`（默认 true）；表头强调色带 + 白字；奇数数据行斑马纹；整数千分位、0–1 占比列百分号；自动筛选
- PDF：`pdfTemplate.ts` 检测无 `<style>` / 无外链 CSS 时套内置报告模板；`template`: auto/report/none；套模板且未显式传 `margins` 时 Electron 边距归零，改由 CSS `@page` 管，避免双边距

测试证据：

- Word：封面两节、`styles.xml` 含 Heading1/2 与 navy 色、表格 XML 含 accent/zebra；`cover:false` 只有一节
- Excel：表头 ARGB = navy.accent、第 3 行斑马纹、收入列 `#,##0`、占比列带 `%`；`zebra:false` 不打纹
- PDF：裸 HTML `templateApplied=true` 且注入标记；已有 `<style>` 原样透传；`template:none` 跳过；用户显式 inches margins 优先生效
- 既有 make_docx / make_xlsx / render_pdf / inspect_pdf 回归全绿

## 7. Skill 重写为 HTML 原型暗工序

未改插件目录。全文写在 `scratch/skill-v3-draft.md`，供主会话审后套进 `/Users/chris/Code/Github/cindy-docs-plugin` 重打包。

要点：

- PDF/PPT/Word 先在 `tmp/` 出自包含 HTML 原型（PPT 按 16:9 分屏），再还原；xlsx 不走
- 全程不向用户展示原型、不中途提问
- 工具名/参数与本 worktree `packages/lizi-mcps/src/cindy-docs/` 真实 schema 对齐（含 `inspect_pdf` 的 `path`/`pages`/`maxPages`）
- 纠正旧 skill 错误：`list_tools` 类目是 `author|convert|read` 不是 `docs`；`margins` 是英寸不是毫米；xlsx `header` 是字符串数组不是 `true`
- 「还原词汇表」同步了 theme/layout/cover/subtitle/footer/template/zebra

## 门禁

- `@cindy/mcps` 定向：`cindyDocsDefaults` + `cindyDocsMcpServer` **52/52 绿**
- `@cindy/mcps` `tsc --noEmit` 绿（包没有 typecheck script）
- `pnpm check:i18n` / `check:i18n-glossary` 绿（仅存量警告）
- 仓库根 `pnpm test:unit:related` 因本分支相对 main 面过大，退回近全量：`@cindy/mcps` 仍绿；`apps/desktop` 有 2 条既有失败（`ghostInstallReceipt.test.ts` setup receipt 读成 invalid）+ `updateService.test.ts` 的 `process.exit` unhandled。与本次 cindy-docs 改动无关，未动那些文件。

## 未覆盖

- 未用 Word / PowerPoint / Excel 实机打开目检版式
- `render_pdf` 真 Chromium 出片未验（按纪律未起 Electron；单测用注入回调）
- skill 未打进插件包，全文在 `scratch/skill-v3-draft.md`
