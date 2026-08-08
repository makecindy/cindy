# Cindy iOS 模拟器发版说明

本说明适用于 iOS 模拟器相关 PR 合并后的 macOS 正式发版。

## 结论

原有 Cindy 发版流程基本不变。新增内容只是把内置的
`Cindy iOS Simulator Helper.app` 作为 Cindy.app 的嵌套程序一起签名。

- Helper 使用与 Cindy.app 相同的 `Developer ID Application` 证书和 Team ID。
- 不需要为 Helper 申请单独的证书、App ID 或 provisioning profile。
- 不需要单独公证 Helper；仍然只公证整个 Cindy.app。
- 发布者不应手工补签 Helper，统一打包脚本已经自动处理正确的签名顺序。
- 现有流水线只要继续调用统一打包入口，无需新增独立的 Helper 签名任务。

## 发版前准备

构建机需安装可用的 `Developer ID Application` 证书，并提供现有 macOS 发版所需配置：

- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_SIGN_IDENTITY`
- `APPLE_APP_PASSWORD`

身份信息也可以继续通过
`apps/desktop/scripts/release-regions.json` 的 `<region>.macSigning` 配置；密码和私钥只放在
CI Secret 或构建机 Keychain 中，不得提交到仓库。

## 执行发版

继续使用现有统一打包入口，例如中国大陆版：

```bash
pnpm --filter desktop release:package -- \
  --platform darwin \
  --region cn \
  --version x.y.z
```

Global 版本将 `--region cn` 改为 `--region global`。不指定 `--arch` 时，现有脚本会依次生成
arm64 和 x64 产物。

该命令会自动完成：

1. 构建并放入 `Cindy.app/Contents/Helpers/Cindy iOS Simulator Helper.app`。
2. 签名 Helper 内的 `ios-simulator-sidecar` 可执行文件。
3. 签名 Helper.app，并生成 Sidecar 身份摘要 manifest。
4. 最后签名外层 Cindy.app，使 Helper 和 manifest 一起进入资源封印。
5. 验证签名，公证并 staple 整个 Cindy.app。
6. 运行 iOS 模拟器 packaged release gate，再生成 DMG 和热更 ZIP。

公开发版不得使用 `--allow-unsigned`、`--no-sign` 或 `--skip-smoke` 绕过门禁。

## 发布检查

打包脚本成功退出即表示 Helper 签名、公证和静态 release gate 已通过。发布前可额外抽查：

```bash
codesign --verify --deep --strict --verbose=2 /path/to/Cindy.app
codesign -dv --verbose=4 \
  "/path/to/Cindy.app/Contents/Helpers/Cindy iOS Simulator Helper.app"
xcrun stapler validate /path/to/Cindy.app
```

重点确认 Helper 与主 App 的 `TeamIdentifier` 一致，且 Helper 带有 Hardened Runtime。

## Helper 更新时

Helper 发生任何代码变化后，必须重新执行完整的 Cindy.app 打包、签名和公证。不要替换已签名包
中的 Helper，也不要只对 Helper 重新签名；否则会使摘要、外层资源封印和公证结果失效。

## 插件发布顺序

如果同时发布 iOS 模拟器官方插件，应先发布包含 Host 能力和 Helper 的 Cindy 版本；验证成功后，
再把插件的 `minCindyVersion` 设置为这个实际发布版本并发布插件。这样旧版 Cindy 用户会收到明确的
升级提示，而不会安装一个 Host 尚不支持的插件版本。
