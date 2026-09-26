# 插件文件下载接口

逻辑页使用 `cindy.downloads.start({id,url,sha256,bytes})`，取消使用
`cindy.downloads.cancel({id})`。返回结构为
`{ok:true,token,bytes,sha256,fromCache}` 或 `{ok:false,message}`。

插件必须声明 node 与 network.hosts；仅允许已声明 HTTPS 主机，重定向每跳重新检查。
本接口用于匿名公开文件，不携带 Cookie、账号凭证或自定义请求头；带授权请求继续使用 fetch 槽。
SHA-256 与精确字节数必填，单文件最大 2 GiB。目标由宿主管理，不接受本机目标路径。
面板不获得宿主路径。通过 `node.request({downloadTokens:{archive:token},params:{...}})`
交接给同插件 Node，Host 校验账号、插件、批准身份和文件身份后注入 `params.downloads.archive`。
携带凭据时 params 必须为对象且不得自带 downloads；旧请求不受影响。
路径仅在本次 RPC 生命周期内有效，Node 须在返回前完成读取或复制，不得回传或记录路径。
缓存由账号、插件、请求身份隔离；id 相同且内容相同可复用经校验的文件。
每账号总预算 4 GiB（含在途预留及每项 64 KiB 管理空间），按最近使用回收；下载中和 Node 借用中的文件不淘汰。
缓存满且没有可回收空间时失败。卸载回收该插件缓存；重启后凭据失效，可重新 start 取凭据。
下载使用独立队列和逐块写盘，不占用宿主更新队列，支持重试/续传。

通过 onHostMessage 订阅：
`{type:'event',name:'download-progress',data:{id,phase,loaded,total,speedBps}}`。
phase 为 queued/downloading/verifying/retrying/completed/failed/cancelled。
retrying 附带 attempt、delayMs，completed 附带 fromCache。
校验、重试等阶段不保证具有 loaded/total；界面应使用不确定进度，不能伪造百分比。
下载完成仅表示文件校验完成，插件自己的解包/内容验证应另行展示。

账号切换、插件批准身份改变或调用逻辑页销毁后中止下载，不向新账号发送进度。
旧宿主不存在 downloads 对象时，应提示升级；不能假装已接入进度。
现有 fetch、Node、Library 接口不变，存量插件无须迁移。
