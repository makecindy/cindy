export const REMOTE_CC_MGR_DIR = '$HOME/.xdt-server/v1/cc-manager';
export const REMOTE_CC_MGR_BUNDLE_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.mjs`;
export const REMOTE_CC_MGR_SOCK_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.sock`;
export const REMOTE_CC_MGR_LOG_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.log`;
export const REMOTE_CC_MGR_PID_PATH = `${REMOTE_CC_MGR_DIR}/cc-mgr.pid`;
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
