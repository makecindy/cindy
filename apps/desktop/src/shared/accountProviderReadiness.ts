/**
 * 「当前账号的模型来源还不可用」这件事的稳定标记。
 *
 * 会话启动门（maker-host 的 `prepareStartOptions`）在未登录 / 正在切账号时会拒绝
 * 启动。但主机的投递通路只把失败压成 `errorCode` + `message` 两个字符串，调用方拿
 * 不到原始 Error 对象，也就分不清「等一会儿会好」和「不登录永远不会好」。
 *
 * 所以这个标记同时写进抛出的 `error.code` 与 `error.message`：任何一层只要看得见
 * 其中之一，就能把它判成**需要用户介入的终态**，而不是继续无限重试。
 *
 * 放在 shared 而不是 maker-host：抛的一侧在 maker-host，判的一侧在 maker-ipc，
 * 让两边都朝一个无依赖的叶子模块看齐，避免任何一侧被迫反向依赖对方。
 */
export const ACCOUNT_PROVIDER_NOT_READY_CODE = 'ACCOUNT_PROVIDER_NOT_READY';
