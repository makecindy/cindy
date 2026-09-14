export const REMOTE_CC_MGR_DIR = '$HOME/.xdt-server/v1/cc-manager';
export const REMOTE_CC_MGR_BUNDLE_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.mjs`;
export const REMOTE_CC_MGR_SOCK_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.sock`;
export const REMOTE_CC_MGR_LOG_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.log`;
export const REMOTE_CC_MGR_PID_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.pid`;
export const REMOTE_PI_MANAGER_DIR = '$HOME/.xdt-server/v1/pi-manager';
export const REMOTE_PI_MANAGER_BUNDLE_PATH = `${REMOTE_PI_MANAGER_DIR}/pi-manager.mjs`;
export const REMOTE_PI_MANAGER_SOCK_PATH = `${REMOTE_PI_MANAGER_DIR}/pi-manager.sock`;
export const REMOTE_PI_MANAGER_LOG_PATH = `${REMOTE_PI_MANAGER_DIR}/pi-manager.log`;
export const REMOTE_PI_MANAGER_PID_PATH = `${REMOTE_PI_MANAGER_DIR}/pi-manager.pid`;
// 会话级状态(socks/ env/)由 daemon 在 REMOTE_PI_MANAGER_DIR 下按需创建,
// 无独立 state 目录常量 —— 退役审轮 5 LOW:REMOTE_PI_MANAGER_STATE_DIR 是
// 无消费方死常量, 已删除, 防止未来有人按不存在的目录拼路径。
export const REMOTE_XDT_NODE_PATH = '$HOME/.xdt-server/v1/node/bin/node';
export const REMOTE_CLAUDE_SHIM_PATH = '$HOME/.xdt-server/v1/node_modules/.bin/claude';

/**
 * 远端 install root (codex-home / node / cc-manager 的公共父目录)。
 * codex-remote-transport 的 daemon wrapper 与 agent-proxy 的 env marker
 * 都以它为基准; 改这里要同步两端。
 */
export const REMOTE_INSTALL_ROOT = '$HOME/.xdt-server/v1';
/**
 * Agent Proxy 隧道 env marker: 远端 shell 片段 (export HTTPS_PROXY=...),
 * codex daemon wrapper 启动前 source 它。删文件 = 关闭代理。路径在
 * install root 而非 CODEX_HOME 内, 避免被 codex 自己的目录管理误删。
 */
export const REMOTE_AGENT_PROXY_ENV_PATH = `${REMOTE_INSTALL_ROOT}/agent-proxy.env`;
