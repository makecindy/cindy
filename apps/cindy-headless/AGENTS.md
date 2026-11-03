# Cindy Headless

修改、同步或出包本模块前先读 UPDATE_AND_PACKAGE.zh-CN.md。
默认出包入口为 pnpm --filter cindy-headless package:release，生成 Linux x64 formal full package。
生成的 bundle、release、runtime binaries、凭证和运行记录不提交源码仓库；分发时保留归档与 manifest/SHA256。
日常迭代可先运行 pnpm --filter cindy-headless verify；提交/PR 门禁遵循根 AGENTS.md 和 development-workflow.md，不豁免涉及依赖锁或测试调度的全量门禁。
