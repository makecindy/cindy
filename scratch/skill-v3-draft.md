---
name: document-workshop
description: 在 Cindy 里用内置 cindy_docs 工具面把内容做成真文件。触发词——PDF、Word、docx、PPT、slides、deck、汇报稿、Excel、xlsx、表格、数据表、报告，以及「做成 PDF」「导出 Word」「做个 PPT」「出个表格」「写份报告」这类说法；也用于读已有的 xlsx / csv 表格。不适用——读写代码文件、编辑 Google Docs / Sheets / Slides 等云端文档、只在对话里给 Markdown 或纯文本、生成图片素材。
---

# 做文档

> **本技能只依赖 Cindy 宿主内置的顶层文档工具。** 动手前确认工具列表里直接有
> `make_pptx` / `make_docx` / `make_xlsx` / `render_pdf` / `read_sheet` / `inspect_pdf`。
> 不要用 shell 自己拼一套替代品（headless Chrome、pandoc、python-docx 之类）冒充产出。
> 这套基础能力不依赖插件；插件未来只负责模板选择、面板引导和成品记录。

正式文档（PDF / PPT / Word）一律走「HTML 原型暗工序」：先在 `tmp/` 写出自包含设计
原型，再对着原型还原进目标格式，最后内部体检。**全程不向用户展示原型、不中途提问、
不把 `tmp/` 路径念给用户听。** 用户只收 `documents/` 里的成品。xlsx 不走这套，直接
组装表格。

## 路线表（先定路线，再动手）

| 用户要什么                           | 暗工序                               | 还原                                  |
| ------------------------------------ | ------------------------------------ | ------------------------------------- |
| PDF、报告、要打印/要发出去的正式文档 | `tmp/` 里写目标纸张的自包含 HTML     | `render_pdf` 无损直渲 + `inspect_pdf` |
| PPT、slides、deck、汇报稿            | `tmp/` 里按幻灯片分屏写 HTML（16:9） | `make_pptx` 按版式逐页复刻            |
| Word、docx、要对方能改的文稿         | `tmp/` 里写 A4 报告原型              | `make_docx` 按标题/封面/表格逐段复刻  |
| Excel、xlsx、数据表、导出表格        | **不走 HTML**                        | `make_xlsx` 直出                      |
| 已有的 xlsx / csv / tsv 要读         | —                                    | `read_sheet`                          |

不要做 docx→pptx、pdf→docx、HTML→PPT 自动转换。HTML 原型只给你自己看版式，
还原必须走对应结构化工具。

## 0. 怎么调这些工具

六个工具是顶层直接调用的：例如直接调 `make_pptx`，不要再寻找已经下线的
`list_tools` / `call_tool` 二级分派入口。工具描述是排版工序的第一事实来源；本技能只补充
跨格式选型、HTML-first 暗工序和交付自检。

硬边界（宿主强制）：

- 所有输入输出路径必须落在**当前会话的工作目录内**，路径穿越会被拒；
- 输出文件已存在时不会静默覆盖，要显式传 `overwrite: true`；
- `render_pdf` 有 30 秒渲染超时，超时是真失败，不是「慢一点就好」。

## 1. HTML 原型暗工序（PDF / PPT / Word 共用）

动手顺序固定，不要跳，也不要跟用户商量「要不要先出个草稿」：

1. **定画幅与主题**（自己定，不问）：
   - PDF / Word → A4 纵向（宽表才横向）；
   - PPT → 16:9，一页一屏；
   - 色板默认 `light`；用户说投影/深色就 `dark`；说正式汇报/商务就 `navy`。
2. **在 `tmp/` 写一份自包含 HTML 原型**（单文件、内联 `<style>`、不引外链字体与外链 CSS）。
   文件名 `tmp/YYYY-MM-DD-<主题>-prototype.html`。PPT 必须按幻灯片分屏，每一屏是
   一个固定画幅的 `.slide`（建议 `1280×720` 或 `13.333in × 7.5in`），首页封面、
   章节切换分节、其余内容页。
3. **对着原型还原**：
   - PDF：原型就是源，`render_pdf({ htmlPath })` 直渲；
   - PPT / Word：不要把 HTML 丢给转换器。按下面的还原词汇表，把标题、副题、要点、
     表格、强调色逐段填进 `make_pptx` / `make_docx`。
4. **内部体检**（见第 7 节）。失败就改原型或改还原参数，重出成品，不要把半成品交给用户。
5. **只交付 `documents/` 里的成品。** 原型留在 `tmp/` 作设计源，用户说「第三节改一下」
   时先改原型再还原，不把 HTML 路径说出去。

`html` 内联参数只给一次性、不值得留源的小页面用；正式文档用 `htmlPath` 指 `tmp/`
里的原型。

### 还原词汇表（主题升级后的参数，必须照这个填）

| 你在原型里看到的        | 还原时填                                                         |
| ----------------------- | ---------------------------------------------------------------- |
| 浅底、打印、默认        | `theme: "light"`                                                 |
| 深底、投影              | `theme: "dark"`                                                  |
| 商务蓝、正式汇报        | `theme: "navy"`                                                  |
| PPT 首页大标题          | `layout: "cover"`，副题写 `subtitle`                             |
| PPT 章节页              | `layout: "section"`                                              |
| PPT 普通页              | `layout: "content"`（默认）                                      |
| 标题下的一行导语        | `subtitle`                                                       |
| 演讲者稿                | `notes`，别堆进 `body`                                           |
| 右半区图                | `imagePath`（工作目录内真实 png/jpg/gif）                        |
| 页脚 + 页码             | `footer: true`（默认）；封面本身不显示页码                       |
| 不要页脚                | `footer: false`                                                  |
| Word 独立封面           | 给 `title`（默认就会出封面）；副题/密级写 `subtitle`             |
| Word 不要封面           | `cover: false`                                                   |
| Excel 表头色带 + 斑马纹 | 默认就有；`zebra: false` 关掉斑马纹                              |
| 无样式的裸 HTML         | `render_pdf` 的 `template` 默认 `"auto"`，会自动套报告模板       |
| 自己已经写了 `<style>`  | 原样透传，不会被覆盖                                             |
| 强制不套模板            | `template: "none"`                                               |
| 页边距                  | `margins` 单位是**英寸**，默认四边 `0.4`；不要传 `20` 这种毫米数 |

色板只有这三个命名值。不要传 `#1F4E79` 这类自由色号，工具不收。

## 2. PDF 路线

`render_pdf { htmlPath | html, outPath, pageSize?, landscape?, printBackground?, margins?, template?, theme?, overwrite? }`
`inspect_pdf { path, pages?, maxPages? }`（只读结构体检，不改文件）

步骤：

1. 按第 1 节写出 `tmp/...-prototype.html`（目标纸张写进 `@page`，套用下面的默认打印 CSS，
   或等价地让 `template: "auto"` 去套 —— 原型里如果已经有 `<style>`，auto 不会再套一层）；
2. `render_pdf({ htmlPath, outPath, pageSize: "A4" })`。宽表格才传 `landscape: true`。
   **`margins` 是英寸**，不传即可。返回值里**必看 `fontsReady` 和 `templateApplied`**；
3. **`inspect_pdf` 体检并核对结论**（见第 7 节，这一步不能跳）；
4. 成品写到 `documents/`。原型留 `tmp/`。

### inspect_pdf 能查什么、查不到什么

返回的是**结构事实**，不是图：

- 逐页：纸型（译成 `A4` / `A4 landscape` 这类可读名）、旋转、文字字符数与一小段
  文字预览、绘制指令数、图像指令数、是否判定为空白页；
- 文档级：`numPages`、`blankPages`、`verdict`（`ok` / `partial-blank` / `blank`）
  以及修复向的警告。
- `pages` 可指定要看的页码（1 起，如 `[1,2,5]`）；不传就从第 1 页顺序取 `maxPages` 页
  （默认 10，上限 50）。

**能确定性抓住**（生成失败的主要形态）：整页无内容、通篇空白、页数与预期对不上、
纸型或方向搞错、该有图的页一条图像指令都没有。

**抓不到**：文字重叠、表格被切在页缝、行距过密、元素叠在一起、单纯不好看——
这些是像素层面的问题，结构体检看不见。所以拿到 `verdict: "ok"` 只能说明
「这份 PDF 不是废件」，不等于「排版没问题」。交付时按第 7 节的说法如实讲清楚。

### 已知坑（结论 + 后果）

- **连字符只用 ASCII `-`。** 正文里混进 U+2011 非断行连字符、U+2013 短破折号这类
  字符，系统字体缺字形时会渲成空格或豆腐块。要长破折号就明确用中文全角「——」。
- **中文字体只写系统字体族，不引 webfont。** 渲染窗拉不到字体就整份回退。
- **`render_pdf` 返回 `fontsReady: false` 就是警报。** 先查字体声明，改完**重新渲染**，
  别拿这一版交付。
- **确实要自带字体时，用 `data:` URI 内联静态 TTF / OTF，绝不用 WOFF。**
- **图片用工作目录内的相对路径。** 外链图片一旦拉不到就是空白块，而且失败不报错。
  无样式 HTML 被自动套模板后会改走内联 HTML，相对路径可能失效 —— 看到
  `templateApplied: true` 且原文有相对图，先把图改成绝对/`data:`，或自己写 `<style>`
  再用 `htmlPath`。
- **别用 `position: absolute` / `float` 排版。** 分页用 `<div class="page-break"></div>`，
  表格/代码块加 `break-inside: avoid`。
- **深色底、反白块必须保留 `print-color-adjust: exact`。**

### 默认打印 CSS（写进原型；无样式时 Core 也会自动套等价模板）

```html
<!doctype html>
<html lang="zh-CN">
  <meta charset="utf-8" />
  <title>文档标题</title>
  <style>
    @page {
      size: A4;
      margin: 18mm 16mm;
    }
    :root {
      --ink: #1b1f24;
      --muted: #6b7280;
      --line: #d8dce2;
      --accent: #2f6feb;
      --wash: #f2f3f5;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      color: #2e3440;
      background: #fff;
      font-family:
        "PingFang SC",
        "Hiragino Sans GB",
        "Microsoft YaHei",
        -apple-system,
        "Helvetica Neue",
        Arial,
        sans-serif;
      font-size: 11pt;
      line-height: 1.7;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    header.cover {
      border-bottom: 2px solid var(--accent);
      padding-bottom: 10pt;
      margin-bottom: 18pt;
    }
    header.cover h1 {
      font-size: 20pt;
      line-height: 1.35;
      margin: 0 0 6pt;
    }
    header.cover .meta {
      font-size: 9.5pt;
      color: var(--muted);
    }
    h2 {
      font-size: 15pt;
      margin: 18pt 0 7pt;
      padding-left: 8pt;
      border-left: 3px solid var(--accent);
    }
    h3 {
      font-size: 12.5pt;
      margin: 13pt 0 5pt;
    }
    h1,
    h2,
    h3 {
      break-after: avoid;
      page-break-after: avoid;
    }
    p {
      margin: 0 0 8pt;
    }
    ul,
    ol {
      margin: 0 0 8pt 1.4em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 10pt 0;
      font-size: 10pt;
    }
    th,
    td {
      border: 1px solid var(--line);
      padding: 5pt 7pt;
      text-align: left;
      vertical-align: top;
    }
    thead th {
      background: var(--wash);
      font-weight: 600;
    }
    tbody tr:nth-child(even) td {
      background: #f7f8fa;
    }
    table,
    figure,
    pre,
    blockquote {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .page-break {
      break-before: page;
      page-break-before: always;
    }
  </style>
  <body>
    <header class="cover">
      <h1>文档标题</h1>
      <div class="meta">2026-08-20 · 作者/来源</div>
    </header>
    <h2>摘要</h2>
    <ul>
      <li>要点一</li>
    </ul>
  </body>
</html>
```

换主色只改 `--accent`，不要另起一套样式体系。`navy` 的强调色是 `#1f4e79`，`dark`
把纸色改成 `#14181d`、字改成浅色。

## 3. PPT 路线

`make_pptx { slides: [{ title, layout?, subtitle?, bullets?, body?, notes?, imagePath? }], outPath, title?, theme?, footer?, overwrite? }`

1. 先按第 1 节写分屏 HTML 原型（一屏一论点）；
2. 对着每一屏填 `slides`：首页 `layout: "cover"`，章节 `section`，其余 `content`；
3. `theme` 与原型主色一致（`light` / `dark` / `navy`）；`title` 会进文件属性和页脚标签；
4. `bullets` ≤5 条、每条一行说完；讲稿写 `notes`。

### pptxgenjs 已知坑（结论 + 后果）

- **颜色由主题色板提供，不要自己传色号。** 若哪一步需要手写色，只传不带 `#` 的 6 位十六进制。
- **文本框和图片要靠版式槽位。** 不要指望转换器猜位置。
- **超长单行不会自动缩字号**，会直接溢出版心。长句在组装数据时就拆成两条。
- **`imagePath` 必须是工作目录内真实存在的 png / jpg / gif。** `.webp` 会先被拦下，避免产出打不开的包。

## 4. Word 路线

`make_docx { markdown, outPath, title?, subtitle?, cover?, theme?, overwrite? }`

1. 先按第 1 节写 A4 HTML 原型（封面、H1–H3、表格长什么样先在 HTML 里定）；
2. 把结构收成 Markdown 再调 `make_docx`。给 `title` 就会出独立封面（`cover: false` 可关），
   副题写 `subtitle`，色板写 `theme`；
3. **不要为了排版去写 HTML 再想办法转 docx**，那条路不存在；
4. 多栏、浮动图文、精确定位这类版式 docx 出口做不了。用户要那种效果，就走 PDF 路线，
   并且明说 PDF 不可再编辑。

**中文不用操心字体。** docx 的 OOXML 内容就是 UTF-8 文本，中文字形由用户打开文件时的
Word / WPS / Pages 自己解析。不要为了「保证中文显示」去给 docx 加任何字体相关的花活。

## 5. Excel 路线（不走 HTML 原型）

`make_xlsx { sheets: [{ name, header?, rows }], outPath, theme?, zebra?, overwrite? }`

- 每个主题一个 sheet，sheet 名短；`header` 是**字符串数组**（不是 `true`），给了就会
  加粗 + 主题色带 + 冻结首行 + 自动筛选；
- 数据行默认斑马纹，整数列自动千分位，表头含 `%` / 率 / 占比且数值在 0–1 时自动百分号；
- `rows` 是二维数组，**数值传数值不传字符串**。

### 公式纪律

- **写公式的单元格要连缓存值一起给**：`{ formula: "SUM(B2:B10)", result: 1240 }`。
  只给公式不给 `result` 会直接参数错误，很多阅读器打开就是空白。
- **只用老函数**（`SUM` / `IF` / `VLOOKUP` / `INDEX` + `MATCH`）。`XLOOKUP`、`LET`、
  `LAMBDA` 在旧版 Excel 与多数第三方阅读器里是 `#NAME?`。
- 跨 sheet 引用写全 `'Sheet 名'!A1`，sheet 名含空格时单引号不能省。

## 6. 读表格

`read_sheet { path, sheet?, maxRows? }`

返回结构化行 + 截断标注。`maxRows` 默认 200、上限 5000。看到截断标注就说明还有数据，
按需要再读一段——**不要拿截断结果下结论**。

## 7. 强制 QA（交付前必须做完）

生成成功的返回值**不等于**文件可用。

1. **PDF 必须体检后再交。** 每出一份 PDF 都要 `inspect_pdf`，并逐条核对：
   - `verdict` 是 `ok`（`partial-blank` / `blank` 一律当失败处理）；
   - `numPages` 与预期一致；
   - `blankPages` 为空；
   - 每页纸型与方向是你要的；
   - 该有内容的页文字字符数不为 0、该有图的页图像指令数不为 0；
   - `fontsReady` 不是 `false`；返回的修复向警告全部处理掉。
     任一条不对：回去改 `tmp/` 原型，**只重渲染改过的那份文件**，再体检一遍。

   **交付说明必须如实**：`inspect_pdf` 是结构体检，能抓住空白页、错分页、错纸型、
   整页无内容，**但看不到文字重叠、表格被切、行距过密这类视觉细节**。
   所以只能说「已做结构体检：3 页、A4、无空白页、verdict ok；体检覆盖结构不覆盖
   视觉细节，建议你打开扫一眼版式」。
   **绝对不要说「我看过渲染效果」「排版检查过了」「视觉上没问题」**——你没有看过
   任何一张图，这么说就是编造。也不要提「我先做了个 HTML 原型」。

2. **xlsx 用 `read_sheet` 读回核对**：表头对得上、首行数据没有错位、数值列是数值、
   公式列有缓存值而不是空白。
3. **大小合理性**：带正文的 A4 报告 PDF 一般 ≥ 30KB；docx / pptx / xlsx 出现 1–2KB
   的空壳同理。
4. **结构回报**：PPT 报页数与版式（封面/分节/内容）、报告报小节数、表格报行列数。
5. **Session 作品卡**：四种生成工具都返回统一的 artifact metadata，Cindy 会把真实存在的
   成品显示为统一作品卡（格式封面、标题、副题、数量和 QA 状态）。不要在正文里再手工
   伪造一张文件卡，也不要把 `tmp/` 原型当成成品路径。
6. **插件登记（未来可选）**：若插件面已安装，再由插件记录成品；没有插件不影响内置作品卡。

自检失败时的说法：如实说「体检报 3 页里第 2 页是空白，我改完重出一版」，然后真的
重做。不要说「已生成」了事。

## 8. 输出目录与文件名

- 成品一律写进当前会话工作目录的 `documents/` 子目录；
- 文件名 `YYYY-MM-DD-简短主题.<ext>`，日期取**系统当前日期**；
- **中间产物放 `tmp/`**（HTML 原型、抓来的原始数据、中途的分析文件）。
  `documents/` 里只放能直接交给用户的东西；
- 一件事的多种格式共用同一主题名；
- 同名文件已存在时**不要顺手加 `overwrite: true`**：先问用户是覆盖还是另存
  （尾部加 `-v2`）。覆盖掉的可能是他已经发出去的文件。

## 9. 与插件面板的配合（可选）

插件面（未来可选）可以提供模板选择卡、模板 brief 和成品记录，但这些都不能成为基础
文档生成的前置条件。插件给的是建议结构，不是硬约束；用户要求和内置工具描述优先。

---

Dependencies：Cindy 宿主内置的顶层文档工具（`render_pdf` / `inspect_pdf` /
`make_docx` / `make_pptx` / `make_xlsx` / `read_sheet`）。无外部系统依赖，不需要安装任何本机软件。

PDF workflow adapted from openai/skills pdf skill (Apache-2.0).
