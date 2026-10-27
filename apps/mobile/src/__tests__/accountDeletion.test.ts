import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

describe("mobile account deletion", () => {
  it("lets auth-server eligibility exclusively control settings visibility", () => {
    const settings = source("app/settings.tsx");
    const visibilityBlock = settings.slice(
      settings.indexOf("void auth\n      .getAccountDeletionAvailability()"),
      settings.indexOf("const copyRow"),
    );

    expect(settings).toContain('testID="settings.deleteAccountButton"');
    expect(settings).toContain("{accountDeletionAvailable ? (");
    expect(settings).toContain("style={styles.accountDeletionLinkText}");
    expect(settings).not.toContain(
      "testID: 'settings.deleteAccountButton',\n                      tone: 'danger'",
    );
    expect(visibilityBlock).toContain("availability.available");
    expect(visibilityBlock).not.toContain("membershipKind");
  });

  it("scopes receipts to the current login and clears local credentials without logout", () => {
    const context = source("src/auth/AuthContext.tsx");
    const acceptStart = context.indexOf("const acceptOutcome = useCallback");
    const requestStart = context.indexOf(
      "const requestAccountDeletionChallenge = useCallback",
    );
    const confirmStart = context.indexOf(
      "const confirmAccountDeletion = useCallback",
    );
    const requestBody = context.slice(requestStart, confirmStart);
    const confirmBody = context.slice(
      confirmStart,
      context.indexOf("const getAccountDeletionStatus", confirmStart),
    );
    const acceptBody = context.slice(
      acceptStart,
      context.indexOf("const dispatchLoginAction", acceptStart),
    );

    expect(context).toContain("'cindy.mobile.auth.accountDeletionReceipt'");
    const selectionPending = acceptBody.indexOf(
      "if (outcome.status === 'select_account')",
    );
    const receiptCommit = acceptBody.indexOf(
      "await commitWithClearedAccountDeletionReceipt(() => {",
    );
    expect(selectionPending).toBeGreaterThan(-1);
    expect(receiptCommit).toBeGreaterThan(selectionPending);
    expect(acceptBody.slice(0, selectionPending)).not.toContain(
      "persistAccountDeletionReceipt(null)",
    );
    expect(acceptBody).toContain("pendingAccountDeletionRestoredRef.current =");
    expect(acceptBody).toContain(
      "outcome.accountDeletionRestored === true ||\n        pendingAccountDeletionRestoredRef.current",
    );
    expect(acceptBody.indexOf("setToken(outcome.accessToken)")).toBeLessThan(
      acceptBody.indexOf("setAccountDeletionRestored(deletionWasRestored)"),
    );
    expect(requestBody.indexOf("persistAccountDeletionReceipt")).toBeLessThan(
      requestBody.indexOf("return challenge"),
    );
    expect(context).toContain(
      "serializeAccountDeletionReceiptRecord(realm, receiptToken)",
    );
    const persistStart = context.indexOf(
      "const persistAccountDeletionReceipt = useCallback",
    );
    const persistBody = context.slice(
      persistStart,
      context.indexOf("/* ── 登录人机验证", persistStart),
    );
    expect(persistBody).toContain(
      "await deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY);",
    );
    expect(persistBody).not.toContain(
      "deleteSecureItem(ACCOUNT_DELETION_RECEIPT_KEY).catch",
    );
    const transactionalClearStart = context.indexOf(
      "const commitWithClearedAccountDeletionReceipt = useCallback",
    );
    const transactionalClearBody = context.slice(
      transactionalClearStart,
      context.indexOf("/* ── 登录人机验证", transactionalClearStart),
    );
    expect(transactionalClearBody).toContain(
      "const previousRaw = await getSecureItem(",
    );
    expect(transactionalClearBody).toContain(
      "await setSecureItem(ACCOUNT_DELETION_RECEIPT_KEY, previousRaw);",
    );
    expect(
      transactionalClearBody.indexOf("await deleteSecureItem("),
    ).toBeLessThan(
      transactionalClearBody.indexOf("commit();"),
    );
    expect(transactionalClearBody).not.toContain("await commit()");
    expect(requestBody).toContain(
      "const expectedGeneration = authGenerationRef.current;",
    );
    expect(requestBody).toContain(
      "const expectedRealm = activeAuthRealmRef.current;",
    );
    expect(requestBody).toContain(
      "const expectedPassportId = userRef.current?.passportId ?? '';",
    );
    expect(requestBody).toContain(
      "await serializeRefreshTokenMutation(async () => {",
    );
    expect(requestBody).toContain(
      "await persistAccountDeletionReceipt(\n        challenge.receiptToken,\n        expectedRealm,",
    );
    const capturePassport = confirmBody.indexOf(
      "const deletedPassportId = userRef.current?.passportId ?? '';",
    );
    const confirmRequest = confirmBody.indexOf(
      "client.confirmAccountDeletion(token",
    );
    expect(capturePassport).toBeGreaterThan(-1);
    expect(confirmRequest).toBeGreaterThan(capturePassport);
    expect(confirmBody).toContain(
      "const deletionGeneration = authGenerationRef.current;",
    );
    expect(confirmBody).toContain(
      "const deletedRealm = activeAuthRealmRef.current;",
    );
    expect(confirmBody).toContain(
      "await serializeRefreshTokenMutation(async () => {",
    );
    expect(confirmBody).toContain(
      "userRef.current?.passportId === deletedPassportId",
    );
    expect(confirmBody).toContain(
      "await removeMobilePassport(deletedRealm, deletedPassportId);",
    );
    expect(confirmBody).toContain(
      "await clearLocalSession({ persistedAuthAlreadyCleared: true });",
    );
    expect(confirmBody).not.toContain(
      "persistAccountDeletionReceipt(input.receiptToken)",
    );
    expect(confirmBody).not.toContain(".logout(");
    expect(confirmBody).toContain("'REQUEST_TIMEOUT'");
    expect(confirmBody).toContain(
      ".getAccountDeletionStatus(input.receiptToken)",
    );

    const logoutStart = context.indexOf("const logout = useCallback");
    const logoutBody = context.slice(
      logoutStart,
      context.indexOf("const getAccessToken", logoutStart),
    );
    const vaultClear = logoutBody.indexOf(
      "clearMobileLoginCredentialsForLogout({",
    );
    const sessionSnapshot = logoutBody.indexOf(
      "readSessionRaw: () => getSecureItem(AUTH_SESSION_KEY)",
      vaultClear,
    );
    const sessionDelete = logoutBody.indexOf(
      "clearSession: () => deleteSecureItem(AUTH_SESSION_KEY)",
      sessionSnapshot,
    );
    const receiptDelete = logoutBody.indexOf(
      "clearReceipt: () => persistAccountDeletionReceipt(null)",
      sessionDelete,
    );
    const sessionRestore = logoutBody.indexOf(
      "restoreSessionRaw: restorePersistedAuthSessionRaw",
      sessionDelete,
    );
    const runtimeClear = logoutBody.indexOf(
      "clearLocalSession({ persistedAuthAlreadyCleared: true })",
    );
    expect(sessionSnapshot).toBeGreaterThan(-1);
    expect(vaultClear).toBeGreaterThan(-1);
    expect(sessionSnapshot).toBeGreaterThan(vaultClear);
    expect(sessionDelete).toBeGreaterThan(sessionSnapshot);
    expect(receiptDelete).toBeGreaterThan(sessionDelete);
    expect(sessionRestore).toBeGreaterThan(sessionDelete);
    expect(runtimeClear).toBeGreaterThan(receiptDelete);

    const statusStart = context.indexOf("const getAccountDeletionStatus");
    const statusBody = context.slice(
      statusStart,
      context.indexOf("const clearAccountDeletionReceipt", statusStart),
    );
    expect(statusBody).toContain(
      "const realm = accountDeletionReceiptRealmRef.current;",
    );
    expect(statusBody).toContain("await loadMobileEndpointsForRealm(realm);");
    expect(statusBody).toContain(
      "authClientFor(did, realm).getAccountDeletionStatus(receiptToken)",
    );
  });

  it("requires a six-digit code and explicit acknowledgement", () => {
    const deletion = source("app/account-deletion.tsx");
    const confirmStart = deletion.indexOf("const confirm = useCallback");
    const confirmBody = deletion.slice(
      confirmStart,
      deletion.indexOf("const available", confirmStart),
    );

    expect(deletion).toContain('testID="accountDeletion.codeInput"');
    expect(deletion).toContain('testID="accountDeletion.acknowledgement"');
    expect(deletion).toContain(
      "disabled: busy || code.length !== 6 || !acknowledged",
    );
    expect(deletion).toContain("testID: 'accountDeletion.confirmButton'");
    expect(deletion).toContain("loginText('accountDeletionAcknowledgeCopy')");
    expect(deletion).not.toMatch(/[\u4e00-\u9fff]/);
    expect(confirmBody).not.toContain("router.replace('/login')");
  });

  it("localizes the deletion entry, screen, and restored notice across all five locales", () => {
    const settings = source("app/settings.tsx");
    const layout = source("app/_layout.tsx");
    const loginMessages = source("src/auth/loginMessages.ts");

    expect(settings).toContain("loginText('accountDeletionSettingsAction')");
    expect(layout).toContain("loginText('accountDeletionRestoredTitle')");
    expect(layout).toContain("loginText('accountDeletionRestoredCopy')");
    expect(
      loginMessages.match(/accountDeletionAcknowledgeCopy:/g),
    ).toHaveLength(5);
    expect(loginMessages).toContain("其他客户端会在登录状态失效后退出");
    expect(loginMessages).toContain(
      "other clients will sign out when their sign-in session becomes invalid",
    );
    expect(loginMessages).not.toContain("通常不超过 1 分钟");
    expect(loginMessages).not.toContain("normally within one minute");
  });

  it("handles terminal REST auth failures without logout loops", () => {
    const context = source("src/auth/AuthContext.tsx");

    expect(context).toContain("terminalLogoutInFlightRef");
    expect(context).toContain("error.code === 'ACCOUNT_UNAVAILABLE'");
    expect(context).toContain("code === 'INVALID_TOKEN'");
    expect(context).toContain("code === 'UNAUTHORIZED'");
    expect(context).toContain("const runProtectedAuthRequest = useCallback");
    expect(context).toContain(
      "await terminateSessionImplRef.current('ACCOUNT_UNAVAILABLE')",
    );
  });

  it("shows persisted status and forwards Apple authorization codes when available", () => {
    const login = source("app/(auth)/login.tsx");
    const loginMessages = source("src/auth/loginMessages.ts");
    const nativeSocial = source("src/auth/nativeSocial.ts");
    const panel = login.slice(
      login.indexOf("function AccountDeletionStatusPanel"),
      login.indexOf("function socialLabel"),
    );

    expect(login).toContain('testID="login.accountDeletionStatus"');
    expect(panel).toContain("loginText('accountDeletionPendingTitle')");
    expect(panel).toContain("loginText('accountDeletionPendingCopy')");
    expect(panel).toContain("getAuthLocale()");
    expect(panel).not.toMatch(/[\u4e00-\u9fff]/);
    expect(loginMessages.match(/accountDeletionPendingTitle:/g)).toHaveLength(
      5,
    );
    expect(loginMessages).toContain("现在重新登录即可取消注销");
    expect(loginMessages).toContain("Sign in now to cancel deletion.");
    expect(login).toContain("cause.code === 'INVALID_RESPONSE'");
    expect(login).toContain("if (status.status === 'completed') stopPolling()");
    expect(nativeSocial).toContain("if (!credential.identityToken)");
    expect(nativeSocial).not.toContain("!credential.authorizationCode");
    expect(nativeSocial).toContain("...(credential.authorizationCode");
  });

  it("renders the deletion status as an opaque overlay bubble with a completed-only underline link (figma 678:1075)", () => {
    const login = source("app/(auth)/login.tsx");
    const tokens = source("src/theme/tokens.ts");
    const panel = login.slice(
      login.indexOf("function AccountDeletionStatusPanel"),
      login.indexOf("function socialLabel"),
    );

    // 浮层定位:frame 由 resolveDeletionBubbleFrame(stage, insets.top) 解析
    // (safe-area 走 insets,不硬编码状态栏高),面板以 absolute 落在 viewport 坐标。
    expect(login).toContain("resolveDeletionBubbleFrame(stage, insets.top)");
    expect(panel).toContain("left: frame.left");
    expect(panel).toContain("top: frame.top");
    expect(panel).toContain("width: frame.width");
    expect(panel).toContain("styles.deletionBubble");
    // 内部几何按 frame.scale 折算(设计单位 → 物理 pt),不再写死物理值
    expect(panel).toContain(
      "const scaled = (designUnits: number) => designUnits * frame.scale",
    );
    expect(panel).toContain("borderRadius: scaled(B.radius)");
    expect(panel).toContain("padding: scaled(B.padding)");
    expect(panel).toContain("fontSize: scaled(B.font)");
    expect(panel).toContain("lineHeight: scaled(B.lineHeight)");
    expect(panel).toContain("marginTop: scaled(B.titleBodyGap)");
    expect(panel).toContain("marginTop: scaled(B.bodyLinkGap)");

    // 气泡不再渲染在 680 设计 px 缩放容器内(修「被登录面板覆盖」的结构根因):
    // 缩放容器开标签到 {stateContent} 之间不得再出现面板引用。
    const scaledGroupSlice = login.slice(
      login.indexOf("transform: [{ scale: groupScale }]"),
      login.indexOf("{stateContent}"),
    );
    expect(scaledGroupSlice).not.toContain("AccountDeletionStatusPanel");
    // 渲染序:登录组之后、协议弹窗之前——盖住立绘/字标/面板/社交行,modal 拦截仍最上层。
    expect(login.indexOf("frame={deletionBubbleFrame}")).toBeGreaterThan(
      login.indexOf("transform: [{ scale: groupScale }]"),
    );
    expect(login.indexOf("frame={deletionBubbleFrame}")).toBeLessThan(
      login.indexOf("{consentDialogOpen ? ("),
    );

    // 三状态:pending/processing 无按钮(调用点 onDismiss 仅 completed 才给),
    // completed 渲染「我知道了」下划线文字链,保留原 onPress/testID/accessibilityRole。
    expect(login).toContain("accountDeletionStatus.status === 'completed'");
    expect(login).toContain("() => void auth.clearAccountDeletionReceipt()");
    expect(panel).toContain("{onDismiss ? (");
    expect(panel).toContain("<Pressable");
    expect(panel).toContain('accessibilityRole="button"');
    expect(panel).toContain("onPress={onDismiss}");
    expect(panel).toContain('testID="login.accountDeletionDismissButton"');
    expect(panel).toContain(
      "hitSlop={resolveDeletionBubbleLinkHitSlop(frame.scale)}",
    );
    expect(panel).toContain("styles.deletionBubbleLinkText");
    expect(login).toContain("textDecorationLine: 'underline'");

    // 气泡样式契约:不透明底 + 1px 描边(走 login 色板新条目)、圆角/padding/排版
    // 全部消费 LOGIN_DELETION_BUBBLE 常量,无固定高、无阴影/elevation、无动画。
    expect(login).toContain("backgroundColor: colors.login.deletionBubbleBg");
    expect(login).toContain("borderColor: colors.login.deletionBubbleBorder");
    expect(login).toContain("borderWidth: LOGIN_DELETION_BUBBLE.borderWidth");
    expect(login).toContain("color: colors.login.controlText");
    expect(login).toContain("color: colors.login.secondaryText");
    // 缩放相关几何不许留在 StyleSheet 里(会变成未折算的物理值)
    const styleSlice = login.slice(
      login.indexOf("deletionBubble: {"),
      login.indexOf("stepHeader:"),
    );
    expect(styleSlice).not.toContain("LOGIN_DELETION_BUBBLE.radius");
    expect(styleSlice).not.toContain("LOGIN_DELETION_BUBBLE.padding");
    expect(styleSlice).not.toContain("LOGIN_DELETION_BUBBLE.font");
    expect(styleSlice).not.toContain("LOGIN_DELETION_BUBBLE.lineHeight");
    const bubbleStyleSlice = login.slice(
      login.indexOf("deletionBubble: {"),
      login.indexOf("stepHeader:"),
    );
    expect(bubbleStyleSlice).not.toContain("height");
    expect(bubbleStyleSlice).not.toContain("shadow");
    expect(bubbleStyleSlice).not.toContain("elevation");
    expect(panel).not.toContain("Animated");

    // 旧实现的文档流内静态块与全宽按钮已退役。
    expect(login).not.toContain("MainWindowActionButton");
    expect(login).not.toContain("styles.deletionStatus");
    expect(login).not.toContain("styles.fullButton");

    // 色板契约:底/描边双态值(figma 678:1075,桌面 chat-input 实值);
    // 标题/链接复用 controlText、正文复用 secondaryText,不新增文字色条目。
    const lightPalette = tokens.slice(
      tokens.indexOf("light: {"),
      tokens.indexOf("dark: {"),
    );
    const darkPalette = tokens.slice(tokens.indexOf("dark: {"));
    expect(lightPalette).toContain("deletionBubbleBg: '#FFFFFF'");
    expect(lightPalette).toContain("deletionBubbleBorder: '#D7D7D4'");
    expect(darkPalette).toContain("deletionBubbleBg: '#1F1F1E'");
    expect(darkPalette).toContain("deletionBubbleBorder: '#3C3C3A'");
    expect(tokens).not.toContain("deletionBubbleText");
    expect(tokens).not.toContain("deletionBubbleTitle");
  });

  it("gates the bubble behind panel entrance (PR #464 review: hidden & non-interactive until done)", () => {
    const login = source("app/(auth)/login.tsx");
    // 结构性跟随:气泡包在 Animated.View 里,opacity = panelEntrance.opacity(与登录组
    // 同一个 usePanelEntrance Animated 值,不新造状态机);pointerEvents 仅
    // handoffPhase === 'done' 放行——splash/handoff 期间气泡不可见也不可点。
    const gate = login.slice(
      login.indexOf("{accountDeletionStatus && deletionBubbleFrame ? ("),
      login.indexOf("{/* 服务条款和隐私协议确认弹窗"),
    );
    expect(gate).toContain("<Animated.View");
    expect(gate).toContain(
      "pointerEvents={handoffPhase === 'done' ? 'box-none' : 'none'}",
    );
    // 全屏包装层禁止 'auto':RN 下 absoluteFill 的 View 即使透明也会吃掉命中区,
    // 挡住下方登录组的输入框/按钮/社交入口(Greptile 审查 P1)。
    expect(gate).not.toContain("? 'auto' : 'none'}");
    expect(gate).toContain("{ opacity: panelEntrance.opacity }");
    expect(gate).toContain("StyleSheet.absoluteFill");
    // 入场完成后(done)才允许交互;disabled/条件渲染等替代形态未引入。
    expect(gate).not.toContain("disabled=");
    // 气泡本体仍不引入 Animated(动画只在包装层,组件保持纯静态)。
    const panel = login.slice(
      login.indexOf("function AccountDeletionStatusPanel"),
      login.indexOf("function socialLabel"),
    );
    expect(panel).not.toContain("Animated");
  });

  it("hides the bubble from screen readers while modal or before the handoff reveals login (PR #464 codex)", () => {
    const login = source("app/(auth)/login.tsx");
    const gate = login.slice(
      login.indexOf("{accountDeletionStatus && deletionBubbleFrame ? ("),
      login.indexOf("{/* 服务条款和隐私协议确认弹窗"),
    );
    // 两种时刻都不该被念出:① 协议弹窗打开(气泡是弹窗兄弟浮层,accessibilityViewIsModal
    // 仅 iOS 生效);② 入场未完成(opacity/pointerEvents 只管渲染与命中,读屏照念)。
    // iOS 与 Android 属性都要给,条件收敛到一个常量避免两处漂移。
    expect(login).toContain(
      "const realmConsentOpen = realmConfirmation !== null;",
    );
    expect(login).toContain(
      "const deletionBubbleA11yHidden =\n    consentDialogOpen || realmConsentOpen || captchaChallengeOpen || handoffPhase !== 'done';",
    );
    expect(gate).toContain(
      "accessibilityElementsHidden={deletionBubbleA11yHidden}",
    );
    expect(gate).toContain(
      "deletionBubbleA11yHidden ? 'no-hide-descendants' : 'auto'",
    );
    // 登录组那层仍按弹窗条件隐藏(它本身在入场动画容器内,不需要入场条件)。
    expect(login).toContain(
      "consentDialogOpen || realmConsentOpen || captchaChallengeOpen\n            ? 'no-hide-descendants'\n            : 'auto'",
    );
  });
});
