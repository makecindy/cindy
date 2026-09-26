# 插件文件下载接口

逻辑页使用 `cindy.downloads.start({id,url,sha256,bytes})`，取消使用
`cindy.downloads.cancel({id})`。返回结构为
`{ok:true,path,bytes,sha256,fromCache}` 或 `{ok:false,message}`。

插件必须声明 node 与 network.hosts；仅允许已声明 HTTPS 主机，重定向每跳重新检查。
本接口用于匿名公开文件，不携带 Cookie、账号凭证或自定义请求头；带授权请求继续使用 fetch 槽。
SHA-256 与精确字节数必填，单文件最大 2 GiB。目标由宿主管理，不接受本机目标路径。
成功路径可传给本插件 Node 进程读取。缓存由账号、插件、请求身份隔离；id 相同且内容相同可复用缓存。
文件按需保留以支持重试/续传，插件不应生成随机 id 来反复下载同一内容。

通过 onHostMessage 订阅：
`{type:'event',name:'download-progress',data:{id,phase,loaded,total,speedBps}}`。
phase 为 queued/downloading/verifying/retrying/completed/failed/cancelled。
retrying 附带 attempt、delayMs，completed 附带 fromCache。
校验、重试等阶段不保证具有 loaded/total；界面应使用不确定进度，不能伪造百分比。
下载完成仅表示文件校验完成，插件自己的解包/内容验证应另行展示。

账号切换、插件批准身份改变或调用逻辑页销毁后中止下载，不向新账号发送进度。
旧宿主不存在 downloads 对象时，应提示升级；不能假装已接入进度。
现有 fetch、Node、Library 接口不变，存量插件无须迁移。
