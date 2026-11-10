# 阶段 2 证据（可验证部分）

采集环境：本机 `cindy-host`，临时 profile（沿用现有 Desktop 登录写入的 same
`safe-storage` 记录）。以下内容已脱敏：不含 token、cookie、codec 参数值。

## 1. 登录入口真实可达

```
$ node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts login --method=google
Opening the Cindy login page in your browser…
If it does not open, visit:
https://auth.cindy.app/api/auth/social/google/authorize?client_type=desktop&device_id=…&
  redirect_uri=https%3A%2F%2Fauth.cindy.app%2Fapi%2Fauth%2Fdesktop%2Fcallback&
  code_challenge=…&code_challenge_method=S256&client_state=…
```

- 使用与 Desktop 相同的托管回调（`client_type=desktop` + PKCE S256 + `client_state`）。
- 缺少 `--method` 时明确报错并列出可用方法，不猜测：

```
cindy-host login failed: choose a login method with --method=: apple, google
```

- 该 authorize 端点真实可达（伪造参数返回 400，说明服务端在校验参数）。

## 2. 重启免登录（复用现有凭据）

Host 重启后读取同一 `safe-storage` 记录，无需再次授权：

```
$ curl -s http://127.0.0.1:3456/health
{"runtime":"ready","authenticated":true,"realm":"global","agents":["claude-code","codex"]}
```

## 3. 两条授权路径均已覆盖（桩 IdP，非真实账号）

- **托管回调轮询**：`pollDesktopAuthorization` 先返回 `pending`、再返回 `ok(code)`，
  登录完成并写入记录（`realm` 随区域）。
- **回环监听**：本地桩端点 302 回 Host 的 loopback，PKCE/state/code 兑换/落盘全链路。


`apps/host/src/auth/login.loopback.test.mjs` 用本地桩授权端点重定向回 Host 的 loopback
监听，覆盖：PKCE S256 校验（challenge 与 verifier 一致）、`state` 校验、code 兑换、
`safe-storage` 记录写入。另一个用例证明 `state` 不匹配时**拒绝**且不落盘。

## 4. 一键读取（脱敏）

```bash
CINDY_HOST_DATA_DIR=<profile> CINDY_HOST_KEYRING_APPLICATION=Cindy \
  node --import tsx --import ./apps/host/src/loaders/register-raw.mjs apps/host/src/main.ts status --json
```

只输出 `{"authenticated":…,"realm":…}`，不含任何令牌。

## 5. Headless / 无 Secret Service 的显式失败（实测）

```
$ CINDY_HOST_KEYRING_APPLICATION=DefinitelyMissingApp cindy-host login --method=google
cindy-host login failed: Secret Service is not available for application "DefinitelyMissingApp" ...;
unlock the login keyring and retry
```

- 无密钥时抛 `CREDENTIAL_STORE_UNAVAILABLE`（`SafeStorageUnavailableError`），不落明文、不静默降级。
- 有密钥时写入记录为 `0600`，磁盘内容不含明文，读取可还原。

## 6. 未验证项（需要用户本人凭证）

- 在真实浏览器完成一次 Google/Apple 授权并让 `code` 兑换写入 `safe-storage`。
  这一步必须由账号持有人操作，自动化无法代替，也不能用手工构造的 code 冒充。
- 因此阶段 2 保持「进行中」；其余部分（凭据读写、续期、登出、重启免登录）已有单测与实测。
