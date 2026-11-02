## 0a 先按宿主版本定位开源源码（tag / commit）

编写、修改或回答插件宿主 API 问题时，先确定插件实际运行的 Cindy 版本，再核对该版本的
公开接口和实现。随包手册用于发现能力与理解契约；源码用于核实具体行为和手册疑点。
官方客户端仓库是 https://github.com/makecindy/cindy，包含 desktop、mobile 和共享 packages；
服务端不在此仓库中，客户端代码不能证明服务端已经部署某项能力。

### 先确定宿主和不可变的源码版本

1. 确认插件会在哪台 Cindy 电脑运行。手机或远程设置页只是控制端时，应核对插件执行电脑，
   不能拿手机应用、控制端电脑或底层 Claude Code / Codex / Pi 的版本代替宿主版本。
2. 从已发现的只读宿主能力取得版本。当前 Cindy 可先发现
   `cindy_helper.list_tools({category: 'app_update'})`，再通过 `call_tool` 调用
   `check_app_update`，读取 `currentVersion`。这一步不安装或重启应用；更新状态不受支持
   也可能仍有版本字段。该工具只查询其所在电脑，不要为它编造跨电脑参数。目标电脑的版本
   无法直接读取时，可请用户提供那台电脑侧栏左下角账号卡片显示的版本号。
3. 若有该运行构建的 `sourceCommit`，优先核验并使用它；打包资源的 `cindy-source.json`
   可提供此字段，但旧版本可能没有。只在已确认的目标应用资源目录按需读取；不要假设安装版
   附带源码。`0.0.0`、开发版或个人构建需要核实实际构建来源；本地源码有未提交修改时，
   commit 只代表已提交的基础源码。插件的 `/app-context` 当前不提供版本或 commit，
   不能捏造字段或 API。
4. 对正式发布的构建，在官方仓库核实对应的实际 tag。通常是 `v<currentVersion>`，必须保留
   `-beta` 等后缀并验证 tag 存在；不要只靠拼接名字就宣称匹配。将 tag 解析为完整 commit，
   annotated tag 要继续解析其指向的 commit。若 tag 与可信构建 commit 不一致，以实际构建
   为依据并说明差异。tag、commit 均无法确认时，不选最近版本、latest 或 main 代替。

### 按所锁定的 commit 只读查源码

优先使用当前可用的 GitHub 插件、gh 或网页读取指定 ref；无需为一次查询克隆整个仓库。
本地已有官方仓库时，可以用 `git show` 读取历史文件，无需切换或重置用户的工作分支。
以下占位符需替换为已核实的值：

```sh
git ls-remote --tags https://github.com/makecindy/cindy.git 'refs/tags/<verified-tag>' 'refs/tags/<verified-tag>^{}'
git -C <source-repo> rev-parse 'refs/tags/<verified-tag>^{commit}'
git -C <source-repo> show '<full-commit>:apps/desktop/src/preload/ghostPreload.ts'
```

证据链接使用 `https://github.com/makecindy/cindy/blob/<full-commit>/<repo-relative-path>#L<line>`。
对结论有影响的手册、类型、实现和测试使用同一个 commit；从 main 看到的能力只能作为
未来版本线索。当前工作目录的 HEAD 也需要与宿主构建核对，不能因为目录叫 Cindy 就认定匹配。

### 顺着公开入口核对实际行为

下面的路径是查找入口；历史版本目录不同或文件缺失时，在该 commit 的树内继续检索。

| 要核实的内容 | 源码入口 |
| --- | --- |
| 对应版本的手册 | `apps/desktop/resources/system-skills/cindy-plugin-creator/`；更早版本沿其实际手册位置查找 |
| manifest 声明与校验 | `packages/plugin-protocol/src/manifest.ts`、`apps/desktop/src/shared/ghost.ts` |
| 电子脑能调用的公开桥接方法 | `apps/desktop/src/preload/ghostPreload.ts` |
| 管子请求的处理、资格与权限 | `apps/desktop/src/main/cindy-brain/index.ts` 及对应的 `*Slot.ts` / 服务实现 |
| 设置页、panel、mainView 同源端点 | `apps/desktop/src/main/cindy-brain/runtime/electronSandboxAdapter.ts` |
| 手机与远程页面 | `apps/desktop/src/main/cindy-brain/mobilePageService.ts`、`apps/mobile/src/plugins/PluginPage.tsx`、`packages/device-link/src/pluginPages.ts` |
| 打包校验与产物 | `apps/desktop/src/main/cindy-brain/forge.ts` |

对本次要依赖的 API，继续读宿主处理与相关测试，核对参数、返回值、能力声明、权限、
平台及运行条件。Main 内部函数、类型声明或测试里的 mock 单独存在，都不能证明插件可调用。
代码存在也不表示当前账号已授权、运行环境已就绪或服务端支持；执行时仍要检测接口并处理
不支持、权限拒绝和真实错误。验证目标版本支持某接口，也不能据此推断它首次发布的
`minCindyVersion`，兼容声明仍按实际确认的首个正式版本填写。

### 版本、网络或源码不可核实时

明确说明未核实的范围，继续依据当前宿主随包手册和可用的运行时结果做能完成的工作；
不要将检索不到源码等同于没有该能力，也不要凭 main 给旧宿主增加接口。需要该证据才能
完成的部分保留待核实项。源码与手册有差异时给出具体 API、commit 和文件证据，区分
源码结论与实际调用结果，再选择当前宿主能工作的公开路径。
