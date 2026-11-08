# Skill library index

按当前任务检索本地技能，选中后读取原文。库内名称和简介留在索引中，Agent 的自动发现目录只安装一个轻量入口。

本包提供可复用的 Node API、Cindy 原生工具接入、CLI 和发现 Skill 生成器。它与 Cindy 现有 Skill 安装方式配合使用；
机制、数据流及宿主接入说明见[架构文档](../../docs/skill-library-index.md)。

## 在 Cindy 中直接使用

告诉 Cindy 要登记的技能目录，例如：

> 把我的 `D:/SkillLibrary` 登记为 personal-methods 技能库，以后做任务先从这里找方法。

Agent 通过 `cindy_helper` 的 `skills` 类目调用 `configure_local_skill_library`，宿主建立索引，
并在现有共享 Skill 目录安装一个短入口。也可指定 `gateway_path` 把入口安装到当前项目的技能目录。
原文目录放在原生自动扫描根之外，保持原位置与资源结构；自动发现目录只安装这个入口。

使用流程是：

1. 新任务启动时只发现一个短技能入口，说明如何检索。
2. Agent 用当前任务描述调用 `search_local_skills`；宿主在该任务首次搜索时同步已登记来源，之后复用索引。
3. Agent 选择少量候选，通过 `read_local_skill` 读取所需原文，再按需读取原目录中的资源。

无需构建 CLI、设置可执行文件路径或在任务中运行 shell 命令。库内名称与简介不写入启动入口。
任务中修改或新增技能后，调用 `configure_local_skill_library(action="refresh")` 更新索引。
重新登记可调整来源；`action="remove"` 取消登记，保留原始技能及已安装入口，返回入口位置供管理。

未选择向量模型时直接使用关键词检索。登记时指定 `embedding_model` 可使用 Cindy 已配置的可用目录模型，
由宿主调用现有向量服务与凭据。自定义供应商 API 还可以使用下方独立 CLI 接入。

本机普通任务使用该入口；伙伴原有的个人技能目录与管理列表继续沿原有入口使用。

## 独立 CLI：构建

先按[贡献指南](../../CONTRIBUTING.md)安装仓库依赖，然后在仓库根执行：

```sh
pnpm --filter @cindy/skill-index build
node packages/skill-index/dist/cli.cjs --help
```

构建生成一个自包含 Node CLI。运行需要 Node.js 22.12 或更高版本，运行时不需要 pnpm，
也不需要从这个可执行文件旁加载 `node_modules`。把 `dist/cli.cjs` 放到长期使用的位置，
再生成下面的发现入口；入口会记录它的绝对路径。

## 建库并接入 Cindy

把技能正文放在原生自动扫描目录之外，例如 `~/SkillLibrary`。每项仍是原来的
`SKILL.md`、`references/`、`scripts/`、`assets/`，可以按领域分目录。
索引数据放到用户数据目录，例如 `~/.cindy/skill-libraries/personal`。

下面在仓库根运行；Windows PowerShell 同样支持这些命令，`$HOME` 为用户目录。

```sh
node packages/skill-index/dist/cli.cjs init --library "$HOME/.cindy/skill-libraries/personal" --source "$HOME/SkillLibrary"
node packages/skill-index/dist/cli.cjs gateway --library "$HOME/.cindy/skill-libraries/personal" --output "$HOME/.agents/skills/cindy-skill-library"
```

Cindy 的新任务发现 `cindy-skill-library` 后，会按其中的入口在开工时检索当前目标，读取命中的技能。
Claude、Codex、Pi 均通过 Cindy 已有的共享 Skill 目录使用这个入口。项目专用库也可以把入口安装到
项目的 `.agents/skills/cindy-skill-library`，相同索引可由多个入口引用。

库的正文目录负责存放技能，`.agents/skills` 负责发现这个入口。若正文原本已经安装在
原生自动扫描目录，先决定它们的正式库位置；`gateway` 只生成入口，不移动现有技能或修改任何引擎配置。
只在原生目录增加入口、同时保留所有技能的原生挂载，会继续加载原来的简介。

查看实际检索与读取结果：

```sh
node packages/skill-index/dist/cli.cjs search --library "$HOME/.cindy/skill-libraries/personal" --query "给拖拽卡片增加回弹手感"
node packages/skill-index/dist/cli.cjs read --library "$HOME/.cindy/skill-libraries/personal" --id "<搜索返回的 id>"
```

`search` 默认返回五项候选，可用 `--limit` 指定数量；只包含名称、简介、来源、匹配词与原文路径。
`read` 返回原文、`resourceRoot`、内容哈希及分页位置。返回 `nextOffset` 时，携带 `--offset`
和上一页的 `--sha256` 继续，直到 `eof: true`。正文与相对资源始终从原目录读取。
分页偏移与长度按 JavaScript UTF-16 字符单元计算；调用者使用返回的偏移，无需自己计算。

## 可选：连接向量 API

关键词检索开箱可用。希望用自然表达、同义句跨领域寻找方法时，再启用兼容 OpenAI embeddings 协议的 API。

先将 API key 放入运行 CLI 的环境变量，例如 `SKILL_EMBEDDING_KEY`。配置只保存变量名，不保存 key。
由 Cindy 调用时，其工具进程也需要继承该变量。

```sh
node packages/skill-index/dist/cli.cjs embedding --library "$HOME/.cindy/skill-libraries/personal" --base-url "https://embeddings.example.com/v1" --model "your-embedding-model" --key-env SKILL_EMBEDDING_KEY
```

命令为已有条目生成向量并保存到本地。API 接收的是名称、简介、别名与标签；不发送技能正文、
资源内容、来源路径。查询时再嵌入当前搜索语句，用关键词排名与向量相似度共同排序。
模型支持指定输出维度时可加 `--dimensions`。请求使用普通 `input` 数组，不发送供应商专属的 `input_type`。

`--base-url` 接受供应商的 API 前缀，保留 `/v1`、`/api/paas/v4` 等路径；仅填写域名时使用 `/v1`。
例如智谱的普通 API 端点可以直接使用 `embedding-3`：

```sh
node packages/skill-index/dist/cli.cjs embedding --library "$HOME/.cindy/skill-libraries/personal" --base-url "https://open.bigmodel.cn/api/paas/v4" --model embedding-3 --dimensions 512 --key-env SKILL_EMBEDDING_KEY
```

该配置已通过真实 API 的建库、中文任务检索、重启复用和增量更新验证。
端点及参数见[智谱 Embedding-3 文档](https://docs.bigmodel.cn/cn/guide/models/embedding/embedding-3)。

关闭向量检索：

```sh
node packages/skill-index/dist/cli.cjs embedding --library "$HOME/.cindy/skill-libraries/personal" --off
```

关键词索引继续可用。再次启用相同 API、模型和维度时，未变化条目的向量可以复用。

## 日常维护

新增库来源，或技能内容改变之后同步：

```sh
node packages/skill-index/dist/cli.cjs add --library "$HOME/.cindy/skill-libraries/personal" --source "$HOME/TeamSkills"
node packages/skill-index/dist/cli.cjs sync --library "$HOME/.cindy/skill-libraries/personal"
```

同步报告新增、变更、删除及向量复用数量。只有检索元数据改变的技能才重新嵌入；只改正文中的
操作细节不重新生成向量，`read` 立即读取新正文。日常搜索只读已同步索引，不在每次任务启动时重扫或重建全库。

索引保存 API 返回的实际模型标识。供应商将同一别名切换到新模型时，检索或增量更新会提示重建；执行
`sync --library <directory> --rebuild` 为整库生成同一模型的向量。

同一库的配置修改与索引更新共用 `library.lock`，同时发起的第二个写操作会收到忙碌提示，待前一个完成后再执行。
锁内记录写进程 PID；若写进程被强制结束，确认该进程已停止后移除库目录中的 `library.lock`，再运行 `sync`。

技能作者可以在现有 YAML `metadata` 下提供可选检索线索：

```yaml
name: spring-motion
description: Tune drag release, spring motion and settling time.
metadata:
  aliases: [回弹手感, spring tuning]
  tags: [拖拽, 惯性, 回弹]
```

`metadata` 是现有 Skill frontmatter 字段。普通技能只写名称与简介也能建立索引。
目录链接按真实路径去重；同一份正文经多个来源发现时只登记一次，来源以配置中首次出现者为准。

## 给宿主开发者

`SkillIndex` 接收宿主已有的技能描述符，不依赖 Electron 或目录布局：

```ts
import { SkillIndex } from '@cindy/skill-index';

const index = new SkillIndex(savedSnapshot);
index.sync(allowedSkills); // 当前任务可用的目录，保留原始 id/source/filePath
await index.buildVectors(embeddingAdapter); // 可选，在库更新时运行
const result = await index.search(taskText, { embedding: embeddingAdapter });
const selected = index.resolve(result.matches[0].id);
const nextSnapshot = index.snapshot();
```

宿主管理自己的来源范围与凭据，索引负责检索。`library` 子路径提供文件发现、持久化和按需读取，
`embedding` 子路径提供现有 `EmbeddingClient` 的 API 适配。CLI 是这套接口的完整参考消费者。

## 验证

```sh
pnpm --filter @cindy/skill-index typecheck
pnpm --filter @cindy/skill-index test
```

测试覆盖任务检索、可注入向量召回、增量重嵌、重启复用、原文分页、资源相对路径，以及库扩展后发现入口保持不变。
示例库位于 [`examples/skills`](examples/skills)，可以作为 `--source` 直接试用。
