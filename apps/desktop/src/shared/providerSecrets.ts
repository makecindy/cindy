/**
 * providerSecrets.ts (shared, 跨进程)
 * ---------------------------------------------------------------------------
 * 供应商 API key(密钥)在本机的存储约定 —— 单一事实来源(SSoT)。
 *
 * 设计背景:Cindy 的供应商密钥一律 **本地 only**,只存 Electron safeStorage
 * (委托 OS keychain / DPAPI 加密),从不同步 / 上传到服务器。历史上各处用裸字符串
 * ("api_key" / "mivo_api_key")指代存储键名,随供应商增多容易散落、写错。本模块
 * 把「providerId → safeStorage 存储键名」收敛成唯一映射:
 *   - main 端经 providerSecretStore 读写;
 *   - renderer 端默认通过通用 safeStorage IPC 访问键；明确列出的 main-only 键除外，不得通过 generic bridge
 *     读取、覆盖或删除。动态 custom provider / MCP 键也依赖这一兼容策略。
 *
 * 新增供应商:在 ProviderSecretId 加 id、在 STORAGE_KEYS 加映射即可。
 *   - xd / mivo 沿用历史键名,避免迁移已有用户本机已存的 key;
 *   - 新供应商按 `provider_key_<id>` 约定;键名必须匹配 /^[a-zA-Z0-9_-]+$/
 *     (safe-storage IPC 的合法键名校验,见 bootstrap-electron isValidKey)。
 */

/** 供应商密钥的稳定标识。新增供应商时在此扩展。 */
export type ProviderSecretId =
  | 'xd'
  | 'mivo'
  | 'brave'
  | 'tavily'
  | 'xai'
  | 'voice-asr'
  | 'gemini'
  | 'openai-images';

/**
 * providerId → safeStorage 存储键名(.enc 文件名,不含后缀)。
 * 改动须谨慎:键名变了等于"换文件",会让用户本机已存的 key 读不到。
 */
const STORAGE_KEYS: Record<ProviderSecretId, string> = {
  // XD 网关 key(sk-...)。历史键名,renderer/main 多处已写入,保持不变。
  xd: 'api_key',
  // Mivo key(mivo_...)。历史键名,保持不变。
  mivo: 'mivo_api_key',
  // Brave / Tavily 网页搜索工具 key。历史键名,保持不变。
  brave: 'brave_search_api_key',
  tavily: 'tavily_api_key',
  // xAI(SuperGrok)OAuth 凭证 blob(JSON:access/refresh/expires),供 responses-bridge 直连 api.x.ai。
  xai: 'provider_key_xai',
  // Voice input's user-configured realtime ASR credential is intentionally
  // isolated from chat/model gateway keys.
  'voice-asr': 'voice_input_asr_api_key',
  // Google Gemini API key(图像通道,2026-07 图像多来源)。按新供应商约定命名。
  gemini: 'provider_key_gemini',
  // OpenAI 平台 API key(仅图像通道,2026-07 图像多来源)。与 ChatGPT 订阅 OAuth
  // (codex-home/auth.json)是两套凭证:订阅 token 调不了平台 images API(实测
  // 401/403 缺 scope),聊天照旧走订阅,图像走这把平台 key。
  'openai-images': 'provider_key_openai_images',
  // 未来新增示例(届时在 ProviderSecretId 与此处同步添加):
  //   anthropic: 'provider_key_anthropic',
  //   openai:    'provider_key_openai',
};

/** 所有已登记的 providerId(用于遍历 / 批量操作)。 */
export const PROVIDER_SECRET_IDS = Object.keys(STORAGE_KEYS) as ProviderSecretId[];

/** 解析某供应商密钥的 safeStorage 存储键名(.enc 文件名,不含后缀)。 */
export function providerSecretStorageKey(id: ProviderSecretId): string {
  return STORAGE_KEYS[id];
}

/**
 * SSH 远端常驻 codex daemon 经 remote-forward 直连本机 MCP bridge 时使用的
 * persistent bearer token 的存储键名。
 *
 * 与 bridge 主 token (per-run 随机, 经 env 给本地 codex 子进程) 不同:daemon
 * env 在其 spawn 时固定, 需要跨 app 重启稳定, 因此落 safeStorage。main-only:
 * renderer 没有正当读取场景, 不经通用 safe-storage IPC 暴露。
 */
export const REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY = 'remote_mcp_bridge_token';

const MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS = new Set<string>([
  STORAGE_KEYS['voice-asr'].toLowerCase(),
  STORAGE_KEYS['gemini'].toLowerCase(),
  STORAGE_KEYS['openai-images'].toLowerCase(),
  REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY.toLowerCase(),
]);

/** Custom-provider runtime header blobs are main-only credential material. */
export const CUSTOM_PROVIDER_HEADER_SECRET_PREFIX = 'provider_headers_';

/**
 * Whether the generic Renderer safeStorage bridge may access this logical
 * key. Main-only credentials use dedicated IPC that never returns plaintext.
 */
export function isRendererAccessibleSafeStorageKey(storageKey: string): boolean {
  const normalized = storageKey.toLowerCase();
  return (
    !MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS.has(normalized)
    && !normalized.startsWith(CUSTOM_PROVIDER_HEADER_SECRET_PREFIX)
  );
}

/**
 * 用户自定义供应商**某 runtime** 的密钥 safeStorage 存储键名（`provider_key_<id>_<agent>`）。
 *
 * per-runtime 独立密钥：一个供应商的 Claude Code / Codex 两个端点可能用不同 key，故按 agent 分开存。
 * 自定义供应商 id 是动态的，不进上面的 `ProviderSecretId` 闭合枚举，这里单独走泛化键名。
 * id 限制为 /^[a-z0-9_-]+$/、agent 为 `claude-code` / `codex`（均只含字母/数字/连字符），故拼出的
 * 键名满足 safe-storage IPC 的 isValidKey 校验（/^[a-zA-Z0-9_-]+$/）。main（路由 resolve 读）与
 * renderer（表单写/清）共用本函数，保证两端键名一致、读写同一 .enc 文件。
 */
/**
 * 动态键名片段的安全校验（最后防线）:存储键名会被直接拼成 safe-storage 目录下的
 * `.enc` 文件名，含 `/` `\` `.` 等字符的 id（如 `x/../../oauth`）会让文件写出存储目录。
 * 自定义供应商 id 已由 store 校验、目录 provider.id 已由 parseCatalog 校验，
 * 这里在键名构造点再断言一次,任何绕过上游校验的调用直接抛错（调用方均有 try/catch 降级）。
 */
const SAFE_KEY_PART_RE = /^[a-zA-Z0-9_-]+$/;
function assertSafeKeyPart(part: string, label: string): void {
  if (!SAFE_KEY_PART_RE.test(part)) {
    throw new Error(`${label} has illegal characters for a storage key: ${JSON.stringify(part)}`);
  }
}

export function customProviderSecretStorageKey(providerId: string, agent: string): string {
  assertSafeKeyPart(providerId, 'providerId');
  assertSafeKeyPart(agent, 'agent');
  return `provider_key_${providerId}_${agent}`;
}

/**
 * Main-only encrypted blob containing all custom headers for one provider runtime.
 * Header values are never persisted in the custom_providers SQLite row.
 */
export function customProviderHeaderStorageKey(providerId: string, agent: string): string {
  assertSafeKeyPart(providerId, 'providerId');
  assertSafeKeyPart(agent, 'agent');
  return `${CUSTOM_PROVIDER_HEADER_SECRET_PREFIX}${providerId}_${agent}`;
}

/**
 * 用户自定义 MCP 服务器 bearer token 的 safeStorage 键名前缀。
 *
 * 账号切换清理(providerSecretStore.clearAll)按此前缀清扫 `mcp_token_*` .enc 文件:
 * MCP 配置表按 userId 切片天然账号隔离,但 safeStorage 键只含 mcpId、不含 userId,
 * 同机不同账号若生成了同名 id 会共用同一 token 文件。故换账号时须连同清掉,避免串号。
 */
export const CUSTOM_MCP_SECRET_PREFIX = 'mcp_token_';

/**
 * 用户自定义 MCP 服务器的 bearer token safeStorage 存储键名（`mcp_token_<id>`）。
 *
 * 自定义 MCP（http/sse 远程型）可选配一个鉴权 token，本地 only、走 safeStorage，不入库/不回传明文。
 * id 限制为 /^[a-z0-9_-]+$/，故拼出的键名满足 safe-storage IPC 的 isValidKey 校验（/^[a-zA-Z0-9_-]+$/）。
 * main（CustomMcpProvider resolve 读）与 renderer（表单写/清）共用本函数，保证两端键名一致。
 */
export function customMcpSecretStorageKey(mcpId: string): string {
  return `${CUSTOM_MCP_SECRET_PREFIX}${mcpId}`;
}

/**
 * 通用 OAuth 供应商（目录 auth.oauth 描述符驱动）的凭证 blob 存储键名
 * （`provider_oauth_<id>`，JSON blob：access/refresh/expires，机制同 xai）。
 * 供应商 id 是目录数据（动态），不进 `ProviderSecretId` 闭合枚举，走泛化键名。
 */
export function providerOAuthStorageKey(providerId: string): string {
  assertSafeKeyPart(providerId, 'providerId');
  return `provider_oauth_${providerId}`;
}

/**
 * 意识(Ghost)network 槽凭证的 safeStorage 键名前缀(凭证保险库)。
 *
 * 账号切换清理(providerSecretStore.clearAll)按此前缀清扫 `ghost_secret_*`:
 * 意识按机器装入、键名不含 userId,同机换账号必须连同清掉,避免串号。
 */
export const GHOST_SECRET_PREFIX = 'ghost_secret_';

/**
 * 官方内置意识凭证 → 历史机器级 provider key 的别名表(老用户兼容)。
 *
 * cindy-web-search 的两条凭证与「工具密钥」时代的 Brave / Tavily key 是**同一
 * 把钥匙**,直接映射到同一存储键(.enc 同一文件):
 * - 老用户在工具密钥页填过的 key,对意识立即生效,零迁移零重填
 *   (lizi_web_search MCP 已于 2026-07-13 退役,意识页是这两把 key 的唯一入口);
 * - 卸载意识不删这两个键(removeGhostSecrets 只扫 ghost_secret_ 前缀,别名键
 *   天然不在扫描面内)——它们是用户填的机器级 key,归属机器不归属意识,
 *   重装意识即恢复可用;换账号仍随 clearAll 清扫(在 PROVIDER_SECRET_IDS 里)。
 * 仅限官方内置意识登记(key 必须是官方保留前缀 id,见
 * GHOST_OFFICIAL_ID_PREFIXES):第三方意识一律走 ghost_secret_ 命名空间;
 * packaged 版本的用户装入通道对官方前缀 id 拒装(cindy-brain/index.ts
 * rejectReservedGhostId),抢注官方 id 蹭别名的路被封死。
 */
const GHOST_SECRET_STORAGE_ALIASES: Record<string, Record<string, string>> = {
  'cindy-web-search': {
    brave_api_key: STORAGE_KEYS.brave,
    tavily_api_key: STORAGE_KEYS.tavily,
  },
  // xd-mivo(前身 cindy-mivo)与「工具密钥」时代的 Mivo key 同一把钥匙
  // (mivo_api_key .enc),老用户填过即对意识生效,零迁移零重填——改名也
  // 不丢:别名映射到底层同一存储键,与 ghostId 无关。
  'xd-mivo': {
    mivo_api_key: STORAGE_KEYS.mivo,
  },
};

/**
 * 意识凭证的 safeStorage 存储键名(缺省 `ghost_secret_<ghostId>_<secretKey>`;
 * 官方别名见 GHOST_SECRET_STORAGE_ALIASES)。
 *
 * 值由用户在该意识设置页填入(renderer 经通用 safeStorage IPC 写),main 只在
 * 代理 fetch 注入时读——凭证明文永不进沙箱、不进管子消息、不进日志。
 * ghostId 规则 /^[a-z0-9][a-z0-9-]{0,31}$/、secretKey 规则 /^[a-z][a-z0-9_]{0,31}$/
 * (validateGhostManifest 已把关),此处按惯例在键名构造点再断言一次。
 */
export function ghostSecretStorageKey(ghostId: string, secretKey: string): string {
  assertSafeKeyPart(ghostId, 'ghostId');
  assertSafeKeyPart(secretKey, 'secretKey');
  const alias = GHOST_SECRET_STORAGE_ALIASES[ghostId]?.[secretKey];
  if (alias) return alias;
  return `${GHOST_SECRET_PREFIX}${ghostId}_${secretKey}`;
}

/**
 * 意识凭证「尾 4 位指纹」的 safeStorage 键名前缀。指纹在**入库那一刻**由
 * deriveGhostSecretTail 截取、与密文分键保管——读路径(/secrets GET)只回
 * 这个预截好的指纹,从头到尾不存在"读明文再现场截"的环节,只写通道的
 * 结构保持干净。前缀与 ghost_secret_ 平行且零碰撞(ghostId 不含下划线,
 * ghost_secret_ 命名空间内第一个 `_` 前必是 ghostId,拼不出 hint_ 开头)。
 * 账号切换清理(clearAll)与卸载清理(removeGhostSecrets)都要连它一起扫。
 */
export const GHOST_SECRET_HINT_PREFIX = 'ghost_hint_';

/** 意识凭证尾指纹的存储键名(无历史别名,不与旧键互通)。 */
export function ghostSecretHintStorageKey(ghostId: string, secretKey: string): string {
  assertSafeKeyPart(ghostId, 'ghostId');
  assertSafeKeyPart(secretKey, 'secretKey');
  return `${GHOST_SECRET_HINT_PREFIX}${ghostId}_${secretKey}`;
}

/** 值长度不足此数时不产指纹(短口令被尾 4 位泄掉的占比太高,宁可不给)。 */
export const GHOST_SECRET_TAIL_MIN_VALUE_CHARS = 12;
/** 指纹长度:尾 4 位(业界惯例;前缀多为公共固定段,回忆价值为零不截)。 */
export const GHOST_SECRET_TAIL_CHARS = 4;

/**
 * 从凭证明文截「尾 4 位指纹」(纯函数,入库时调用一次)。
 * 值太短(< GHOST_SECRET_TAIL_MIN_VALUE_CHARS)返回 null = 不存指纹。
 */
export function deriveGhostSecretTail(value: string): string | null {
  if (value.length < GHOST_SECRET_TAIL_MIN_VALUE_CHARS) return null;
  return value.slice(-GHOST_SECRET_TAIL_CHARS);
}
