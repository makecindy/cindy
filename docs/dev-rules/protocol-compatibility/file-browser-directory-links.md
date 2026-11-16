# 文件浏览器目录链接

`file-browser-core.listDir` 的展示结果支持工作目录内的目录软链接，返回逻辑 `relPath`
和 `type: directory`。完整枚举（无 matcher / `includeIgnored: true`）及全局递归文件
清单仍不跟随链接。越界、失效及文件链接不作为可浏览目录。

目录链接条目追加可选 `symlinkTarget?: string`：目标相对真实工作目录的 POSIX 路径，
根目录为 `''`，不传宿主绝对路径。Desktop 用它把 watcher 的目标路径事件映射回已缓存的
链接目录，合并后只刷新受影响目录，并让正文预览及其缓存失效共用这些别名映射；
映射随现有树缓存回收。访问权限仍由每次文件操作的 realpath 检查决定。
Mobile 现有 watcher 对工作目录事件去抖后刷新当前目录，无需消费此字段。

本地 IPC、SSH file-service 和 `file-browser:remote-op` 透传同一条目。旧控制端忽略
新增字段；新控制端连接旧执行端时字段缺省，保留原刷新行为及手动刷新入口。不新增
channel、能力位、schema 版本或服务端校验。Device Link 的加密业务 payload 与自建中转
保持原样透明传输，无需中转升级；不改变握手、签名、路由或恢复行为。

回归入口：`completeDirectory.test.ts`、`scanner.test.ts`、remote-file-service 的
`rpc.test.ts` 和 Desktop `useFileTree.test.tsx`。分别覆盖目标相对路径、边界/循环、
链接本身的重命名删除、RPC 字段透传，以及目标事件合并和旧字段缺省行为。
