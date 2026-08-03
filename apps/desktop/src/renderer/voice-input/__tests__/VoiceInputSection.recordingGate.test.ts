import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('VoiceInputSection shortcut recording gate', () => {
  it('disables app shortcuts while recording voice input shortcuts', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain("document.body.dataset.appShortcutRecording = '1'");
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(true)');
    expect(source).toContain('delete document.body.dataset.appShortcutRecording');
    expect(source).toContain('window.electronAPI.appShortcuts.setRecording(false)');
  });

  it('checks the active Composer binding before preview and persistence', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const hasComposerVoiceConflict = useCallback(');
    expect(source).toContain('getComposerSendShortcutPreference()');
    expect(source).toContain('findComposerVoiceInputConflict(');
    expect(source).toContain("result.conflict === 'composer-voice-input'");
    expect(source).toContain("settings.shortcuts.errors.composerVoiceConflict");
    expect(source).toContain('findVoiceInputAppShortcutConflict(shortcut, getAppShortcutEntries())');
  });

  it('waits for shortcut suspension before committing and restores the latest persisted shortcut', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('await shortcutSuspendPromiseRef.current');
    // 挂起必须走显式 intent:main 侧按存盘校验同步请求,而挂起传的 null 故意与存盘不同。
    expect(source).toContain('suspendVoiceInputGlobalShortcut().then(');
    // stop 不能按平台门控:挂起那条 IPC 不分平台地在 main 登记了录制会话,而 stop 是唯一摘掉它
    // 的。只在 darwin 发的话,Windows 用户按 Esc 取消后会话一直挂着,恢复同步被「录制中」守卫
    // 拒掉,原来的全局快捷键就一直停用。
    // 断言锁的是**缩进层级**而不是「有没有出现 darwin」:出现在 cleanup 体一层(6 空格)才说明它
    // 无条件执行;一旦被任何 if 包起来缩进就变成 8 空格,两条断言同时翻脸。写成正则匹配
    // `darwin ... stop` 的形态是不够的——那样只要包裹语句里多一个行尾注释就绕过去了(我第一版
    // 就是这么写的,负向验证时没能变红)。
    expect(source).toContain('\n      void window.electronAPI.voiceInput.stopModifierShortcutRecording();');
    expect(source).not.toContain('\n        void window.electronAPI.voiceInput.stopModifierShortcutRecording();');
    expect(source).not.toContain('syncVoiceInputGlobalShortcut(null)');
    expect(source).toContain('shortcutSuspendPromiseRef.current = suspendPromise');
    expect(source).toContain('syncVoiceInputGlobalShortcut(getVoiceInputSettings().shortcut)');
    // 恢复注册要等在飞的提交落地再读存盘：切走 tab 会立刻跑 cleanup，那时存盘还是旧快捷键,
    // 直接恢复会在提交之后把旧的注册回去(存盘/界面指新的、实际生效旧的)。
    expect(source).toContain('const pendingCommit = shortcutCommitPromiseRef.current;');
    expect(source).toContain('void pendingCommit.then(restoreRegistration, restoreRegistration);');
    // 而且要让位给新一轮录制:第一轮提交没落地就结束、紧接着开始第二轮时,这条恢复会经同一条
    // main 队列排在第二轮的挂起之后,把旧快捷键启用回来 —— 用户在第二轮按键试录就会真的触发
    // 一次语音输入。轮次对不上就放弃,那一轮自己会在结束时恢复。
    expect(source).toContain('const recordingSession = (recordingSessionRef.current += 1);');
    expect(source).toMatch(
      /const restoreRegistration = \(\): void => \{\s*\n\s*if \(recordingSessionRef\.current !== recordingSession\) return;/,
    );
    // 录制 effect 刻意**不**依赖监听权限：录制中途授权只需补一次 Fn capture（由权限
    // effect 直接调 startFnKeyCapture），让本 effect 重跑会先由 cleanup 异步恢复已保存
    // 的全局快捷键、再由 setup 挂起，中间那段窗口里用户按下旧快捷键会真的触发语音输入。
    //
    // 这里必须写全依赖数组：只断言 '}, [recordingShortcut]);' 会被同文件另一个 reset
    // effect 的同名数组匹配到，看着通过实则脱靶。
    expect(source).toContain('}, [recordingShortcut, startFnKeyCapture]);');
    expect(source).not.toContain('}, [recordingShortcut, permissions.inputMonitoring.ok, t]);');
  });

  // 上面那条只锁住 effect 自己的依赖数组，但它依赖 startFnKeyCapture —— 后者的依赖一旦
  // 非空（最初是 [t]，身份随界面语言变化），录制期切语言就会经由它的身份变化把整个录制
  // effect 重跑，照样打开「旧快捷键被短暂恢复」的窗口。所以那个 callback 的依赖必须为空，
  // 文案走 translateRef 取最新值。
  it('keeps the Fn capture callback identity stable so the recording effect never re-runs mid-recording', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /const startFnKeyCapture = useCallback\([\s\S]*?\r?\n {2}\}, \[\]\);\r?\n\r?\n  \/\//,
    );
    expect(source).not.toMatch(
      /const startFnKeyCapture = useCallback\([\s\S]*?\r?\n {2}\}, \[t\]\);\r?\n\r?\n  \/\//,
    );
    expect(source).toContain('const translateRef = useRef(t);');
    expect(source).toContain('translateRef.current = t;');
  });

  // main 侧的串行队列只保证最终存盘是最后一次提交，两次提交的结果照旧都会回到 renderer。
  // 过时那次必须在动手之前被挡掉：否则它会收口录制框、弹自己的提示，甚至在用户最新选的
  // 快捷键根本不需要监听权限时（改成了 F16）弹出 macOS 授权窗。
  it('discards a stale shortcut submission before running its side effects', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('const submission = (shortcutSubmissionRef.current += 1);');
    // 闸必须在 superseded 判断和所有副作用之前：先 return 才谈得上「不动手」。
    expect(source).toMatch(
      /const result = await setShortcut\(shortcut\);\s*\n\s*if \(isStaleSubmission\(\)\) return;/,
    );
    // 代次原先只在下一次提交时推进，切走设置 tab 卸载本组件并不会作废在飞的那次 ——
    // 迟到的结果照样弹提示，甚至凭一个用户早已离开的界面上的选择弹出 macOS 授权窗。
    expect(source).toMatch(/useEffect\(\(\) => \(\) => \{\s*\n\s*shortcutSubmissionRef\.current \+= 1;\s*\n\s*\}, \[\]\);/);
  });

  // 授权拿到了 ≠ 快捷键起得来：helper 仍可能 spawn 失败 / 启动超时 / 起来就退。原先这条
  // 补注册是 fire-and-forget，失败被丢掉，而「待授权」说明会随权限转已授权一起消失 ——
  // 用户看到一切正常、按键却没反应。直接提交那条路是会报 listenerUnavailable 的。
  it('surfaces a listener failure when re-registering after the permission is granted', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /const result = await syncVoiceInputGlobalShortcut\(settings\.shortcut\);[\s\S]{0,600}?toast\.error\(translateRef\.current\('settings\.voiceInput\.shortcut\.toast\.listenerUnavailable'\)\)/,
    );
    // 仍缺权限 / 被更晚一轮顶掉都不该弹这条错误：前者待授权说明还在，后者由顶掉它的那轮报。
    expect(source).toContain("if (result.errorCode === 'permission' || result.errorCode === 'superseded') return;");
    // 迟到的结果不弹提示（权限又变了、或组件已卸载）。
    expect(source).toContain('if (cancelled || result.ok) return;');
    expect(source).not.toContain('void syncVoiceInputGlobalShortcut(settings.shortcut);');
  });

  it('clears stale custom ASR form fields when the saved config is removed', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (!selection?.customAsr) {');
    expect(source).toContain("setCustomAsrProtocol('openai-realtime')");
    expect(source).toContain("setCustomAsrWebsocketUrl('')");
    expect(source).toContain("setCustomAsrModel('')");
    expect(source).toContain("setCustomAsrApiKey('')");
  });

  it('preserves a dirty custom ASR endpoint and key across unrelated selection refreshes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('if (customAsrSelected && customAsrFormDirtyRef.current) return;');
    expect(source).toContain('}, [customAsrSelected, selection?.customAsr]);');
    expect(source).toContain('customAsrFormDirtyRef.current = true;');
  });

  it('invalidates a previous connection result when any local custom ASR field changes', () => {
    const source = readFileSync(
      new URL('../../components/settings/VoiceInputSection.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toMatch(
      /setConnectionTest\(\{ status: 'idle' \}\);[\s\S]*customAsrProtocol,[\s\S]*customAsrWebsocketUrl,[\s\S]*customAsrModel,[\s\S]*customAsrApiKey,/,
    );
  });
});
