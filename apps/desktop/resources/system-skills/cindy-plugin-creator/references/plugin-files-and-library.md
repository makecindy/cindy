## 4.10 写文件(fs 能力)

沙箱本身没有文件系统，字节始终由主机落盘。三档目的地的声明边界不同：

- `root:'workdir'`：当前 Agent tool-call 内传 `callId: msg.callId` 即可按会话
  permission mode 写入，不需要 `"fs": true`。
- `root:'save'`：授权是主 Agent 发放的限时、限次、绑定插件票据，不需要
  `"fs": true`。
- `root:'data'`：这是插件脱离当前 Agent 调用仍可持久读写的私有目录，
  属于自主 Host 能力；使用它才声明 `"fs": true`，并在插件详情如实展示。

```js
// 写自己的私有数据目录(免确认;适合缓存、大结果落盘、跨生命周期状态)
const w = await cindy.send({ type: 'fs-request', op: 'write', root: 'data',
  path: 'reports/result.json', content: JSON.stringify(data) });
// w = { ok:true, op:'write', path:'reports/result.json', bytes:12345 } 或 { ok:false, message:'原因' }

// 读回 / 列清单 / 删除(仅限 root:'data')
await cindy.send({ type: 'fs-request', op: 'read',   root: 'data', path: 'reports/result.json' });
await cindy.send({ type: 'fs-request', op: 'list',   root: 'data' });          // 可带 path 列子目录
await cindy.send({ type: 'fs-request', op: 'delete', root: 'data', path: 'reports/result.json' });

// 写当前会话的工作目录(仅 write;必须带 tool-call 下发的 callId)
await cindy.send({ type: 'fs-request', op: 'write', root: 'workdir',
  path: 'output/summary.md', content: text, callId: msg.callId });

// 写主 agent 过户的目录(仅 write;token 来自 ghost_call 顶层 save_dir 注入的 args.save_deposit.token)
await cindy.send({ type: 'fs-request', op: 'write', root: 'save',
  path: 'report.json', content: text, token: msg.args.save_deposit.token });

// 语法糖:cindy.fs({...}) ≡ cindy.send({ type:'fs-request', ...})(同 cindy.fetch)
await cindy.fs({ op: 'write', root: 'data', path: 'a.txt', content: 'hi' });
```

三档目的地(都由主机强制,写错拿到的是结构化拒绝):

- `root:'data'` **私有数据目录**:你的专属储物柜(卸载时整体回收,沉睡保留)。
  免确认,全操作(write/read/list/delete)。配额:总量 256MB、2000 个文件;
  超限写会被拒,自己删旧文件腾地方。**超大工具结果建议落这里再把路径交给
  agent 读**(交卷体量有限时的泄洪通道);
- `root:'workdir'` **会话工作目录**:仅 write,必须带当次 tool-call 的 `callId`
  (主机凭它定位会话,不认自报)。**是否放行跟随该会话的权限模式**——agent
  编辑文件免批的模式直接写;逐条确认的模式会弹确认卡请用户点头(同目录本
  会话批一次);计划/只读模式一律拒。SSH 远程工作区会话不支持(目录在远端
  机器),会明确报错,请改用 root:'data'。例外:scheduler「仅运行脚本」通道
  (无会话的定时脚本直调)下发的调用,以该 schedule 配置的工作目录为写入根
  直接放行——没有会话就没有权限模式可跟随,授权来自 schedule 配置本身;
  该通道的写入必须在当次 tool-call 处理期间完成,交卷后 callId 立即失效
  (比会话通道更严:无宽限,先写盘再交卷);
- `root:'save'` **过户目录**:仅 write,凭主 agent 在 ghost_call 顶层传 `save_dir`
  过户后注入的 `args.save_deposit.token` 写入(与 §4.7 fetch `as:'file'` 下载
  落盘同一张票:限时、限次数、限字节、文件名主机消毒、永不覆盖已有文件)。

通用规则:

- `path` 是相对路径(`a/b/c.ext` 形态):正斜杠分段、最多 16 段、无 `.`/`..`、
  每段以字母/数字/下划线开头且不许以点结尾——**写不了以点开头的隐藏文件**
  (.git / .env 等),这是刻意限制;Windows 保留设备名(NUL / CON 等)也拒;
- `content` 默认按 UTF-8 文本落盘;二进制传 `encoding:'base64'`(read 同理,
  想拿二进制回传 `encoding:'base64'`);单次写入上限 16MB,超了拆多个文件;
- 符号链接一律不穿透:目标是 symlink、或路径经 symlink 逃出根目录,直接拒。

### 4.10.1 持久作品库(library 能力)

声明 `"library": true` 后,你获得一个**用户作品级**的持久存储区——
和 fs 槽的私有储物柜(256MB 配额、卸载即回收)是两个语义:Library 不受配额
约束(只受磁盘水位约束),**卸载插件不删数据**(用户必须在 Cindy 设置里单独
确认才删除)。适合画布、素材库、项目文件这类"用户会心疼"的数据。

位置由用户与宿主决定(装入时可选、随时可在设置里迁移),你**看不到也无需
知道**绝对路径——所有 `path`/`dbPath` 都是库内相对路径,段数放宽到 32、
总长 512(比 fs 槽宽,够 `canvases/<id>/assets/objects/<shard>/<hash>` 深度)。

```js
// 语法糖:cindy.library({...}) ≡ cindy.send({ type:'library-request', ... })
const open = await cindy.library({ op: 'open' });   // 建议启动即调(幂等)
const st = await cindy.library({ op: 'status' });
// st = { ok:true, state:'ready', usedBytes, fileCount, diskFreeBytes,
//        softLimitBytes, softLimitExceeded, location:'default'|'custom' }

// 只读能力查询:资格审与 op 合法性之后、会话创建之前返回;不打开库、不弹窗
const caps = await cindy.library({ op: 'capabilities' });
// caps = { ok:true, op:'capabilities',
//          capabilities:{ version:1,
//            operations:['clipboardWrite','saveAs','staging.begin',...],
//            staging:{ version:1, maxTaskBytes, maxTotalBytes,
//                      maxConcurrentWrites, maxChunkBytes, reserveBytes } } }
// operations 只表示宿主实现了这些 op,不等于此刻有窗口 / 已授权 / 库可用

// 文件操作(全 Family;写入原子化,大文件走分块流)
await cindy.library({ op: 'write', path: 'canvases/c1/state.json', content: s });
await cindy.library({ op: 'read', path: 'canvases/c1/state.json', encoding: 'base64' });
await cindy.library({ op: 'list', recursive: true, cursor: st.nextCursor, limit: 500 });
await cindy.library({ op: 'stat' }); / mkdir / delete({ recursive:true }) / rename({ overwrite:true })

// 大文件分块流(>16MB 必须走这里;sha256 由宿主实算回传,做完整性对账)
const b = await cindy.library({ op: 'writeBegin', path: 'assets/video.bin',
  totalBytes: blob.size, sha256: expectedHash });
for (const chunk of chunks) {
  await cindy.library({ op: 'writeChunk', streamId: b.streamId, seq: n, content: chunkB64, encoding: 'base64' });
}
const done = await cindy.library({ op: 'writeCommit', streamId: b.streamId });
// done = { ok:true, path, bytes, sha256 }; 中断/放弃用 writeAbort

// 在文件夹中显示 / 系统另存为(不回用户所选绝对路径)
await cindy.library({ op: 'reveal', path: 'exports/a.psd' });
const saved = await cindy.library({ op: 'saveAs', path: 'exports/a.psd', name: 'layers.psd' });
// saved = { ok:true, cancelled:true }
//      或 { ok:true, cancelled:false, path:'exports/a.psd', bytes }
// path 永远是库内相对键,不是用户另存到的绝对路径

// 写系统剪贴板 PNG 位图(不是 Finder 文件列表,也不是 saveAs)
const copied = await cindy.library({
  op: 'clipboardWrite', content: pngBase64, encoding: 'base64',
});
// copied = { ok:true, bytes }  —— bytes 是写入的 PNG 字节数
// 空字节 / 非 base64 / 非 PNG / 超限 → { ok:false, errorCode, message }
// 外部应用能否粘上由操作系统剪贴板决定,插件侧不要自己承诺粘贴完成

// SQLite:参数化语句 + 首词白名单(SELECT/WITH/INSERT/REPLACE/UPDATE/DELETE/
// CREATE/DROP/ALTER/REINDEX/ANALYZE);ATTACH/PRAGMA/VACUUM/事务语句一律拒,
// 事务由宿主管理(db.batch 整批原子),迁移按 user_version 幂等续跑
await cindy.library({ op: 'db.open', dbPath: 'library.sqlite' });
await cindy.library({ op: 'db.exec', dbPath: 'library.sqlite',
  sql: 'CREATE TABLE canvases (id TEXT PRIMARY KEY, name TEXT)' });
await cindy.library({ op: 'db.batch', dbPath: 'library.sqlite', statements: [
  { sql: 'INSERT INTO canvases VALUES (?, ?)', params: ['c1', '我的画布'] },
] });
await cindy.library({ op: 'db.migrate', dbPath: 'canvas.sqlite', targetVersion: 2,
  steps: [{ toVersion: 1, sql: ['CREATE TABLE v1 (a TEXT)'] },
          { toVersion: 2, sql: ['CREATE TABLE v2 (a TEXT)'] }] });
await cindy.library({ op: 'db.backup', dbPath: 'library.sqlite' });  // 宿主命名空间
await cindy.library({ op: 'db.check',  dbPath: 'library.sqlite' });  // quick_check

// 后台暂存(staging.*):独立于可迁移 Library 根,不是第二媒体库,不返回 imageRef。
const up = await cindy.library({
  op: 'staging.begin', taskId, sourceRevision, totalBytes, sha256, mime, recovery,
});
await cindy.library({ op: 'staging.chunk', stagingId: up.stagingId, seq: 1, content: b64, encoding: 'base64' });
const receipt = await cindy.library({ op: 'staging.commit', stagingId: up.stagingId });
// receipt.durable === true 才可当跨退出原件。release 带当前 Library ACK 的 bytes(不是 begin 的 totalBytes),且画布已保存后才调用。
await cindy.library({
  op: 'staging.release', stagingId: up.stagingId, path, sha256, bytes,
  libraryIdentity, libraryGeneration,
});
```

关键语义(全部由宿主强制):

- **失败是结构化的**:`{ ok:false, errorCode, message, reason? }`。旧
  `errorCode` 保留;另加稳定 `reason` 供分类,不要解析人类 `message`。
  常用码 `LIBRARY_UNAVAILABLE`(含 open/status 的 binding-moved/disk-missing/corrupt)、
  `LIBRARY_READONLY`、`DISK_FULL`、`PATH_INVALID`、`NOT_FOUND`、
  `ALREADY_EXISTS`、`TOO_LARGE`、`STREAM_INVALID`、`DB_STATEMENT_REJECTED`、
  `DB_ROW_LIMIT`(结果集超 2000 行,自己加 LIMIT)、`DB_MIGRATION_CONFLICT`、
  `BUSY`、`RATE_LIMITED`、`UNSUPPORTED`、`NOT_DECLARED`;
  稳定 `reason`:无 handler=`IMPLEMENTATION_UNSUPPORTED`,无窗口=`NO_VISIBLE_WINDOW`,
  权限=`PERMISSION_DENIED`,库不可用=`LIBRARY_UNAVAILABLE`(含 vault 透传的
  open/status 失败),非法请求=`INVALID_REQUEST`(含非法/越界 dbPath 与未知 op),
  取消=`CANCELLED`;成功 open/status 的 `state:'unavailable'` 仍用结果体 reason
  (如 disk-missing),不是失败 reason 枚举;查询/传输层本地分类 `TIMEOUT` / `TRANSPORT_ERROR`;
- **staging.***:后台暂存,不是媒体库、不弹新 UI。`staging.read` 未传 length 默认 16MiB 分片;负数/NaN offset/length 是 `PATH_INVALID`。release 必须带当前 Library ACK 的 `bytes`(不是 begin 的 `totalBytes`),且只在画布保存后调用。父目录 fsync 失败不得 `durable:true`。
- **capabilities**:先查 `{ op:'capabilities' }`。仅 `version===1` 且
  `operations` 为**全部字符串**的数组才有效;额外字段忽略,未知 operation 忽略,
  已知项保留;有效 v1 清单缺少某项才是 unsupported。缺字段、错类型(含数组内混入
  非字符串)、`version` 非 1、或旧宿主 unknown-op 一律 unknown,不得把其中碰巧
  合法的项当成有效清单。查询本身不证明窗口/授权/库可用,也不要求旧插件重装;
- **reveal / saveAs**:只收库内相对路径。成功不回用户另存目标的绝对路径;
  取消是 `{ cancelled:true }`。reveal 打开系统文件夹、saveAs 弹系统对话框
  (跨平台标题带已核验插件名;macOS 另有正文),同插件 3 秒内连发 `RATE_LIMITED`;
  saveAs 已有对话框在场 `BUSY`(不排队)。
  对话框期间账号切换则拒绝拷贝(`LIBRARY_UNAVAILABLE`);
  拷贝完成替换前、reveal 打开文件夹前再核一次会话;
  确认后先拷到目标旁临时文件再替换,失败不破坏已有文件;
- **clipboardWrite**:只收 `encoding:'base64'` 的 PNG 字节,写系统剪贴板位图,
  成功回 `{ ok:true, bytes }`。不是 saveAs,也不在文件夹中显示作品。
  PNG 字节上限 20MB(20,000,000 字节,按解码后字节计),超限回 `TOO_LARGE`;
  旧版宿主上限为 16MiB,同样回 `TOO_LARGE`,插件应提示用户更新或改用下载。
  空字节 / 非法 encoding / 非 PNG / 超限一律结构化失败,永不 `ok:true`。
  同插件 3 秒内连发 `RATE_LIMITED`;无主壳窗 / 宿主不能写剪贴板 `UNSUPPORTED`;
  账号切换后旧会话不得继续写(`LIBRARY_UNAVAILABLE`)。
  外部粘贴是否成功由操作系统与目标应用决定,插件侧不要单独承诺已粘上;
- **不可用 ≠ 空**:`state:'unavailable'` 时**不要**当空库重建、不要触发
  清理、不要把素材判成已删——如实向用户展示状态,等位置恢复;
- **无跨库事务**:多个 .sqlite 之间没有 ATTACH;跨库一致性用幂等 + 墓碑
  自行设计(每库独立,反而是独立同步/删除的好边界);
- **推荐"先字节后记账"**:先写 asset 文件、再 batch 写元数据行——崩溃只会
  留无账文件(内容寻址可自愈),绝不出现有账无文件;
- **面板展示库内文件**:`cindy-ghost://<你的id>/library/<相对路径>`(只读,
  支持视频 Range)——与 /media/ 的内容寻址缓存不同,这个地址内容可变。

`write`/`writeCommit`/`read` 都回 `sha256`(宿主对实字节计算)——
外自称的哈希只当对账参考,不是凭证。

### 4.10.2 同账号电脑间的插件资料同步

声明 `"deviceSync": true`，使用 `cindy.deviceSync(req)`。这是通用加密传输，不是数据库自动同步；
合并、持久化、幂等和删除标记由插件负责。需要自动接收时声明 `"launch": "resident"`。
先检查 `typeof cindy.deviceSync === 'function'`，旧 Host 保留本地功能，不伪报已同步。

- `{op:'status'}` 返回 `{ok:true, version:1, online, peers:[{deviceId,deviceName}], maxBytes}`。
- `{op:'request', peer, data}` 向同一插件发一个有界 JSON 请求，成功返回 `{ok:true,data}`。
- 对端收到 `{type:'device-sync-request', requestId, peer, data}`；实际持久化后用
  `{op:'reply',requestId,data}` 回复。requestId 由 Host 生成并绑定对端、插件实例和批准版本。
- 单个加密前 envelope（含协议字段）最多 64 KiB，每个插件最多 2 个并发请求，整机 32 个，
  30 秒无应用回执返回 `SYNC_RESULT_UNKNOWN`。它可能已经执行；先对账，只有幂等同步才可重发。
- `SYNC_CONNECTING` 表示密钥握手中，`SYNC_OFFLINE` 表示目前不可达；退出账号、停用、卸载或
  替换插件使旧请求失效。未知错误保留本地资料，并展示可行动状态。
- 双方必须已登录同一账号、在线、是未撤权的电脑，并安装启用 namespace 已确认、声明该能力的
  同一插件（namespace + id）。手机是执行电脑的控制端，不保存独立同步副本；共享任务访客和
  供应商分享不能使用此通道。Node Worker 不获得账号凭证或设备密钥。
- Host 复用 owner-scoped safeStorage 的设备密钥和首次公钥固定机制，采用 X25519 / AES-GCM。
  Device Link relay 只搬运密文；离线没有云端存储，不承诺两台从不同时在线的电脑能够交换。

### 4.10.3 对话里交给插件的文件（cindy_handoff_files）

用户在对话里发 CSV、XLSX 等非媒体文件，页面要等用户点按钮才处理时使用。在工具参数表里
声明保留参数 `cindy_handoff_files`（`{"type":"array"}`），模型就会把这类文件放进 ghost_call
的 attachments；宿主保存一份副本，插件收到
`args.cindy_handoff_files=[{ref:'handoff:<uuid>',name,mimeType,size,sha256,createdAt,expiresAt}]`。
未声明时非媒体文件照旧要求改用 dir。不需要声明 library。在这个工具自己的说明里写明「用户在对话里发的
文件，用 ghost_call 的 attachments 交给本工具」：工具说明离模型的调用决定最近，模型才不会误用 dir。

- 这个参数只由宿主填写：模型或页面自带的同名值会被删掉。页面回传引用请用你自己的参数名。
- 一次最多 4 个文件，单个 64 MiB、一批 128 MiB；每个插件最多保存 512 MiB / 200 个，满了新交接
  会被拒绝。工作目录外的文件按当前权限档确认。
- 处理文件只有两条路：发给后端用 `cindy.fetch({method:'POST',upload:{handoff:[ref]},...})`
  （与 hashes / library 三选一，文件名是净化后的原名，另附 `filename*`）；本机处理则由页面从
  `hostContext.toolInfo.tool._meta['cindy/attachments']` 找到同一 `uri` 的项，用
  `_meta['cindy/file'].url` 读取，在页面里解析后再调用你的 app-only 工具保存结果。
- 插件拿不到字节和路径，也不能删除副本；副本连续 7 天未使用后宿主自动删除（卡片签发地址、
  页面读取、`upload.handoff` 上传成功都算使用，会顺延），用户也可以在插件详情页逐个删除。
  之后上传返回 `errorCode:'HANDOFF_UNAVAILABLE'`，页面上该项没有 `url`；请提示用户重新发送。
  `expiresAt` 是收到时的当前到期时间，使用时会顺延，不要把它当成固定截止时间。
- 手机和其他电脑暂时打不开带这类文件的卡片；Node 工作进程不能使用这个能力。
- 需要 `minCindyVersion: 0.1.123-beta`；旧宿主不认识这个参数，非媒体文件仍会要求改用 dir。

```js
// main.js 里 app-only 的 confirm_import：页面把 ref 作为 file 传回
const reply = await cindy.fetch({ url: 'https://api.example.com/import', method: 'POST',
  upload: { handoff: [msg.args.file] }, callId: msg.callId });
```

### 在交互页面里使用文件

工具返回 resource_link，uri 使用 Library 相对引用或本插件媒体引用；页面从该内容块的
_meta['cindy/file'].url 取临时只读地址。不要拼地址、传本机路径或长期保存页面 URL。
大文件优先由 cindy.pick 写入 Library，再由工具上传；页面不搬运完整文件字节。
参数、限额、拖放和下载写法统一见[§4.23 文件参考](examples/interactive-pages/REFERENCE.md#文件)，
完整代码见[files 示例](examples/interactive-pages/files/)。
