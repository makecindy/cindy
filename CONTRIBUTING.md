<p align="right">
  <strong>简体中文</strong> · <a href="CONTRIBUTING.en.md">English</a>
</p>

# 贡献指南

感谢你为 Cindy 贡献代码、文档和反馈。本仓库是 Cindy 的开源客户端仓，负责
desktop、mobile 及共享 packages；服务端位于独立仓库，不在本仓库的贡献范围内。

## 开始之前

- 开发环境版本和安装步骤以
  [`docs/dev-rules/environment-setup.md`](docs/dev-rules/environment-setup.md) 为准。
- 先阅读 [README.zh-CN.md](README.zh-CN.md) 的安装说明，以及适用的
  [工程规则](AGENTS.md)。`AGENTS.md` 是详细工程约束，不是本指南的替代品。
- 参与社区时请遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)；普通使用问题见
  [`SUPPORT.md`](SUPPORT.md)。
- 不要提交凭证、令牌、授权文件、个人数据或生成的本地数据库。
- 公开版本只锁定公开的协议 submodule commit；插件通过 SkillHub 或手动安装。
  不要把任何凭证写入 Git 配置或仓库文件。

## 给反馈者署名

在 GitHub Issue、X 或 Discord 提出问题或建议的人，都可以在原讨论里确认公开署名。昵称即可上墙。希望作为 Git 共同作者的人可以提供名字和用于公开提交的邮箱（包括自己的 GitHub noreply 地址）。匿名或未确认时不建记录。

维护者在实现 PR（可先开草稿）中添加 `.github/feedback-credits/<本 PR 编号>.json`。仅填本人确认公开的信息。可选的 `replyTo` 表示已约定发版后回复这条公开讨论，支持本仓 Issue、X 帖子和 Discord 公开消息的永久链接。私聊和非公开频道省略此项。

```json
{
  "change": "修复手机切回前台后消息消失的问题",
  "contributors": ["小雨", "River <river@example.invalid>"],
  "replyTo": "https://github.com/makecindy/cindy/issues/123"
}
```

把记录和实现一起暂存，运行 `node scripts/feedback-credits.mjs commit "fix: 修复手机消息恢复"`。命令提交当前暂存区，自动生成共同作者行，并以提交者本人的身份签 DCO。普通 Git 工具也可以提交同样的 trailers。PR 检查核对记录与共同作者；合并时保留提交正文。

公开发布 GitHub Release（含 beta）后，工作流按发布时间和标签实际包含的记录生成[贡献墙](CONTRIBUTORS.md)及官网 JSON，并回告指定的原讨论。每天也会补扫一次。后续 PR 可以修正名字或删除记录，下一次刷新会反映在墙上。Git 历史保留原提交。

回告使用 GitHub Actions 自带的 token。X 需配置具有发帖权限的用户授权 `FEEDBACK_X_USER_TOKEN`；Discord 需配置在目标频道有读取历史和发送权限的 `FEEDBACK_DISCORD_TOKEN`。这些值只放 Actions secrets。工作流先发布贡献墙，再记录每次发送的回执。发送结果不确定时，该 PR 会在运行日志中标出；查原讨论后，在 `community-credits` 分支的 `deliveries.json` 将对应记录改为 `{"status":"sent","id":"消息 ID"}`，或在确认没有发出时移除该记录，再运行 Feedback credits。

## 获取代码与安装

按照[开发环境与依赖准备](docs/dev-rules/environment-setup.md)完成克隆、公开 submodule、
Git LFS 和依赖安装。该文档是安装命令的唯一权威说明；本指南不重复维护命令副本。

## 开发与验证

### 桌面端

启动方式、区域选择、安全重启和验证命令见
[Desktop 开发、启动与验证](docs/dev-rules/desktop-development.md)。

### 手机端

模拟器、原生重建和验证命令见
[Mobile 开发、模拟器与验证](docs/dev-rules/mobile-development.md)。

### 验证

根据改动范围按 [AGENTS.md](AGENTS.md) 的风险分层原则选择检查；Desktop 和 Mobile 的
命令分别以对应开发规则为准。涉及数据库、协议、端点、移动端 scope 或其他专项规则时，
继续读取对应专题并运行其检查。PR 中必须写明实际执行的命令和结果；未执行的高相关
验证必须说明原因。

## 提交 Pull Request

1. 从最新的 `main` 创建短生命周期分支，保持一个 PR 只解决一个清晰的问题。
2. PR 标题使用 `<type>(<scope>): <简短描述>`，例如
   `docs(readme): clarify local mode`。可用 type 见
   [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)。
3. Review 完整 diff，确认没有凭证、无关生成文件或意外的 submodule 指针变化。
4. 按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写变更范围、验证、风险和回滚方式。
5. 从个人 Fork 提交 PR 时，建议保持 `Allow edits from maintainers` 开启，方便维护者和 QA
   直接在原 PR 分支协作修复。若 Fork 包含 GitHub Actions workflow，该选项会显示为
   `Allow edits and access to secrets by maintainers`；开启后，拥有上游仓库 push 权限的维护者
   也能编辑 Fork 中的 workflow，可能暴露 Actions secrets 或取得其他分支的访问权限。
   请仅在接受这一权限范围时开启。
6. 等待 CI 和 review；不要直接向 `main` 推送。

改动附带的排错结论、设计理由和操作流程，如果别人接手时也需要知道，请一并写进相关 `docs/`
文档或测试，而不只留在 PR 讨论或个人笔记里；放哪见开发工作流文档的
[「项目知识放在哪里」](docs/dev-rules/development-workflow.md#4-项目知识放在哪里)。

小型文档修正也欢迎直接提交 PR。较大的架构、协议、数据库 migration、权限或用户数据
变更，建议先开 issue 讨论范围和兼容性。

## 贡献的许可与署名（DCO）

本仓库使用 [Apache-2.0](LICENSE) 许可证。按照其第 5 条，你有意提交到本仓库的任何
贡献，默认按 Apache-2.0 的条款并入并对外分发，无需额外签署 CLA。

我们要求每个 commit 通过 [Developer Certificate of Origin](https://developercertificate.org/)
声明来源合法（DCO 1.1 全文见仓库根的 [`DCO`](DCO) 文件）：提交时使用 `git commit -s`，
在 commit message 末尾生成 `Signed-off-by: 你的名字 <你的邮箱>` 行，表示你有权按上述
条款提交这份贡献。签名里的**名字和邮箱都**必须与该 commit 的 author（或 committer）
一致——这一行是本人声明，不能替别人签。请不要提交你无权授权的代码（例如未经许可
复制的专有代码）。

PR 上的 **DCO check**（[DCO GitHub App](https://github.com/apps/dco)）会校验这个 PR
的每个 commit，merge commit 与 bot 提交豁免，不追溯 DCO 生效前的历史提交。本地可以
提前自查：`pnpm check:dco`。漏签时补签：

```bash
# 只有最新一个 commit 漏签
git commit --amend -s --no-edit

# 多个 commit 漏签（<base> 用 PR 的 base commit）
git rebase --signoff <base>

# 改完后更新 PR
git push --force-with-lease
```

如果不想改写历史（例如 PR 上已经有想保留的 review 讨论），可以改推一个
**remediation commit**：正文里包含下面这行原样格式，其中 sha 是被补签 commit 的完整
40 位 sha，并且这个 commit 自己也要带签名。

```text
I, 你的名字 <你的邮箱>, hereby add my Signed-off-by to this commit: <40 位完整 sha>

Signed-off-by: 你的名字 <你的邮箱>
```

两个 commit 的 author 以及这行里的名字、邮箱必须完全一致。替别人的 commit 补签用：

```text
On behalf of 原作者 <原作者邮箱>, I, 你的名字 <你的邮箱>, hereby add my Signed-off-by to this commit: <40 位完整 sha>

Signed-off-by: 你的名字 <你的邮箱>
```

注意 `pnpm check:dco` 刻意比 PR 上的门禁保守：它只认直接签名、不识别 remediation
commit，也不豁免 bot 提交（bot 身份取决于 GitHub 账号类型，本地判不了）。因此本地通过则
PR 上必过，反之不然——用了 remediation、或范围里含 bot 提交时，以 PR 上的 DCO check 为准。

`git commit` 本身没有「自动签名」的配置项（`format.signOff` 只作用于
`git format-patch` / `git am`）。想一次配好，可以装上本仓的 prepare-commit-msg hook——
正本是 [`.githooks/prepare-commit-msg`](.githooks/prepare-commit-msg)，一个普通 shell
脚本，建议装之前先自己读一遍：`pnpm dco:install-hook` 会把它复制进本地 hooks 目录，
不改远端，删掉已安装的那份即卸载；也可以直接 `git config core.hooksPath .githooks`
（这会接管整个 hooks 目录）。

## 安全问题

不要在公开 issue、PR 或讨论中披露漏洞、凭证或可利用细节。请按
[SECURITY.md](SECURITY.md) 的流程私下报告。英文版见
[SECURITY.en.md](SECURITY.en.md)。
