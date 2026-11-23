import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  pickInitialNewSessionWorkspace,
  resolveInitialNewSessionWorkspaceKind,
  type NewSessionDeviceOption,
  type NewSessionDraft,
  type NewSessionStoredPreferences,
  type NewSessionWorkspaceKind,
  type buildRecentWorkspaceOptions,
} from "./newSession";
import {
  readNewSessionPreferences,
  saveNewSessionPreferences,
} from "./newSessionPreferenceStore";
import { readNewSessionDefaults } from "./newSessionDefaultsStore";
import {
  DEFAULT_NEW_SESSION_DEFAULTS,
  resolveNewSessionDefaultWorkspace,
  type NewSessionDefaultProfileKey,
  type NewSessionDefaults,
} from "./newSessionDefaults";
import type { drainStashedNewSessionDraft as drainStashedDraft } from "./newSessionCreation";
import type { restoreNewSessionDraft } from "./newSessionForm";

type RestoredDraftArgs =
  Parameters<typeof restoreNewSessionDraft> extends [unknown, ...infer Rest]
    ? Rest
    : never;

/** Consume only the failed task addressed by this form, then protect it from late defaults. */
export function useNewSessionStashedDraft(input: {
  sessionId?: string;
  deviceId: string;
  drainStashedNewSessionDraft: typeof drainStashedDraft;
  restoreCreationDraft: (...args: RestoredDraftArgs) => void;
  setAttachmentError: (notice: string) => void;
  onRestoreCollab: (
    stash: NonNullable<ReturnType<typeof drainStashedDraft>>,
  ) => void;
  userTouchedDeviceRef: RefObject<boolean>;
  setSelectedDeviceId: (id: string) => void;
  setSelectedDeviceName: (name: string) => void;
}): void {
  const {
    sessionId,
    deviceId,
    drainStashedNewSessionDraft,
    restoreCreationDraft,
    setAttachmentError,
    onRestoreCollab,
    userTouchedDeviceRef,
    setSelectedDeviceId,
    setSelectedDeviceName,
  } = input;
  useEffect(() => {
    const stashed = drainStashedNewSessionDraft(sessionId, deviceId);
    if (!stashed) return;
    restoreCreationDraft(
      stashed.draft,
      [...stashed.attachments],
      undefined,
      stashed.deviceId || undefined,
    );
    if (stashed.notice) setAttachmentError(stashed.notice);
    if (stashed.collabDraft && stashed.deviceId) onRestoreCollab(stashed);
    if (stashed.deviceId) {
      userTouchedDeviceRef.current = true;
      setSelectedDeviceId(stashed.deviceId);
      setSelectedDeviceName(stashed.deviceName || stashed.deviceId);
    }
  }, [sessionId, deviceId, restoreCreationDraft]);
}

type Setter<T> = Dispatch<SetStateAction<T>>;
interface WorkspaceIdentity {
  selectedDeviceId: string;
  initialWorkingDir: string | null;
  draft: NewSessionDraft;
  userTouchedWorkspaceRef: RefObject<boolean>;
  userTouchedDeviceRef: RefObject<boolean>;
  initialWorkspaceKeyRef: RefObject<string | null>;
  workingDirPreferenceOverridesRef: RefObject<Record<string, string>>;
  workspaceKindPreferenceOverridesRef?: RefObject<
    Record<string, NewSessionWorkspaceKind>
  >;
  newSessionPreferences: NewSessionStoredPreferences | null;
  newSessionPreferencesLoaded: boolean;
  newSessionDefaults: NewSessionDefaults | null;
  preferredDefaultDevice: NewSessionDeviceOption | null;
  setNewSessionPreferences: Setter<NewSessionStoredPreferences | null>;
  setNewSessionDefaults: Setter<NewSessionDefaults | null>;
  setBrowseOpen: Setter<boolean>;
  loadBrowsePath: (path: string) => Promise<void>;
}

export interface NewSessionWorkspacePreferencesInput extends Pick<
  WorkspaceIdentity,
  | "selectedDeviceId"
  | "initialWorkingDir"
  | "newSessionPreferences"
  | "newSessionPreferencesLoaded"
  | "newSessionDefaults"
  | "workingDirPreferenceOverridesRef"
  | "workspaceKindPreferenceOverridesRef"
  | "userTouchedWorkspaceRef"
  | "userTouchedDeviceRef"
  | "preferredDefaultDevice"
  | "setNewSessionPreferences"
  | "setNewSessionDefaults"
> {
  setNewSessionPreferencesLoaded: Setter<boolean>;
  setDraft: Setter<NewSessionDraft>;
  routeDeviceId: string;
  routeDeviceName: string;
  routeDeviceExplicit: boolean;
  deviceOptions: NewSessionDeviceOption[];
  appliedDefaultDeviceKeyRef: RefObject<string | null>;
  setSelectedDeviceId: Setter<string>;
  setSelectedDeviceName: Setter<string>;
  setDevicePickerOpen: Setter<boolean>;
  /** 读取期间用户已保存过默认：不要用迟到的读取结果覆盖。 */
  defaultsEditedRef?: RefObject<boolean>;
}

/** The initial async preference read never replaces a choice made in this form. */
export function useNewSessionWorkspacePreferences(
  input: NewSessionWorkspacePreferencesInput,
): void {
  const {
    selectedDeviceId,
    newSessionPreferences,
    setNewSessionPreferences,
    newSessionPreferencesLoaded,
    setNewSessionPreferencesLoaded,
    workingDirPreferenceOverridesRef,
    workspaceKindPreferenceOverridesRef,
    initialWorkingDir,
    newSessionDefaults,
    setNewSessionDefaults,
    userTouchedWorkspaceRef,
    userTouchedDeviceRef,
    routeDeviceId,
    routeDeviceName,
    routeDeviceExplicit,
    deviceOptions,
    appliedDefaultDeviceKeyRef,
    preferredDefaultDevice,
    setSelectedDeviceId,
    setSelectedDeviceName,
    setDevicePickerOpen,
  } = input;
  const appliedInitialWorkspaceKindRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setNewSessionPreferencesLoaded(false);
    // 默认设置与上次选择一起读完再落设备 / 工作区，避免先按旧记忆画一次再跳。
    void Promise.all([readNewSessionPreferences(), readNewSessionDefaults()])
      .then(([preferences, defaults]) => {
        if (cancelled) return;
        // A late initial read must not replace directories explicitly chosen while it was pending.
        setNewSessionPreferences({
          ...preferences,
          workingDirByDevice: {
            ...preferences.workingDirByDevice,
            ...workingDirPreferenceOverridesRef.current,
          },
          workspaceKindByDevice: {
            ...preferences.workspaceKindByDevice,
            ...(workspaceKindPreferenceOverridesRef?.current ?? {}),
          },
        });
        if (!input.defaultsEditedRef?.current) setNewSessionDefaults(defaults);
        // 工作区模式统一由 useNewSessionInitialWorkspace 按默认设置 / 上次选择决定，
        // 这里不再先写一次，避免弹窗改默认后无法重新生效。
      })
      .finally(() => {
        if (!cancelled) setNewSessionPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // 设置弹窗保存后默认会变；用户已经手动动过电脑或工作区时，不把新默认套到
  // 当前这次新建上（Q10）。首次读取（previous 为 null）仍按默认落设备。
  const appliedDeviceDefaultsRef = useRef<string | null>(null);
  useEffect(() => {
    if (!newSessionPreferencesLoaded) return;
    if (userTouchedDeviceRef.current) return;
    const defaultsKey = JSON.stringify(newSessionDefaults ?? DEFAULT_NEW_SESSION_DEFAULTS);
    const previousDefaults = appliedDeviceDefaultsRef.current;
    if (
      previousDefaults !== null
      && previousDefaults !== defaultsKey
      && userTouchedWorkspaceRef.current
    ) {
      appliedDeviceDefaultsRef.current = defaultsKey;
      return;
    }
    appliedDeviceDefaultsRef.current = defaultsKey;
    const key = [
      routeDeviceId,
      routeDeviceName,
      initialWorkingDir ?? "",
      routeDeviceExplicit ? "explicit" : "default",
      newSessionPreferences?.device?.deviceId ?? "",
      deviceOptions.map((option) => option.deviceId).join(","),
    ].join("|");
    if (appliedDefaultDeviceKeyRef.current === key) return;
    appliedDefaultDeviceKeyRef.current = key;
    setSelectedDeviceId(preferredDefaultDevice?.deviceId ?? "");
    setSelectedDeviceName(
      preferredDefaultDevice?.name ?? preferredDefaultDevice?.deviceId ?? "",
    );
    setDevicePickerOpen(false);
  }, [
    deviceOptions,
    initialWorkingDir,
    newSessionPreferences?.device?.deviceId,
    newSessionDefaults,
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    preferredDefaultDevice?.name,
    routeDeviceExplicit,
    routeDeviceId,
    routeDeviceName,
  ]);
  // Apply the settled device's own remembered workspace mode once preferences load,
  // preserving explicit entry (initialWorkingDir) and restored/manual workspace choices.
  useEffect(() => {
    if (!newSessionPreferencesLoaded || appliedInitialWorkspaceKindRef.current) {
      return;
    }
    const targetDeviceId = userTouchedDeviceRef.current
      ? selectedDeviceId
      : (preferredDefaultDevice?.deviceId ?? "");
    if (!userTouchedDeviceRef.current && selectedDeviceId !== targetDeviceId) {
      return;
    }
    appliedInitialWorkspaceKindRef.current = true;
    if (initialWorkingDir || userTouchedWorkspaceRef.current) return;
    const workspaceKind = resolveInitialNewSessionWorkspaceKind({
      deviceId: targetDeviceId,
      preferences: newSessionPreferences,
      workspaceKindOverrides: workspaceKindPreferenceOverridesRef?.current,
    });
    if (!workspaceKind) return;
    setDraft((current) =>
      userTouchedWorkspaceRef.current
        ? current
        : { ...current, workspaceKind },
    );
  }, [
    initialWorkingDir,
    newSessionPreferences,
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    selectedDeviceId,
  ]);
}

export interface NewSessionWorkspaceActionsInput extends Pick<
  WorkspaceIdentity,
  | "draft"
  | "selectedDeviceId"
  | "initialWorkingDir"
  | "setBrowseOpen"
  | "workingDirPreferenceOverridesRef"
  | "workspaceKindPreferenceOverridesRef"
  | "setNewSessionPreferences"
  | "userTouchedWorkspaceRef"
  | "initialWorkspaceKeyRef"
  | "loadBrowsePath"
> {
  patchDraft: (patch: Partial<NewSessionDraft>) => void;
  setBrowseError: Setter<string | null>;
  setShowHiddenDirectories: Setter<boolean>;
  setWorkspacePickerOpen: Setter<boolean>;
}

/** All explicit workspace choices update the same per-device preference. */
export function useNewSessionWorkspaceActions(
  input: NewSessionWorkspaceActionsInput,
) {
  const {
    draft,
    selectedDeviceId,
    initialWorkingDir,
    patchDraft,
    setBrowseOpen,
    setBrowseError,
    setShowHiddenDirectories,
    workingDirPreferenceOverridesRef,
    workspaceKindPreferenceOverridesRef,
    setNewSessionPreferences,
    userTouchedWorkspaceRef,
    setWorkspacePickerOpen,
    initialWorkspaceKeyRef,
    loadBrowsePath,
  } = input;
  const selectWorkingDir = useCallback(
    (workingDir: string) => {
      patchDraft({ workingDir });
      setBrowseOpen(false);
      setBrowseError(null);
      setShowHiddenDirectories(false);
    },
    [patchDraft],
  );
  const rememberWorkingDirForDevice = useCallback(
    (workingDir: string) => {
      if (!selectedDeviceId || !workingDir.trim()) return undefined;
      workingDirPreferenceOverridesRef.current[selectedDeviceId] = workingDir;
      if (workspaceKindPreferenceOverridesRef) {
        workspaceKindPreferenceOverridesRef.current[selectedDeviceId] =
          "project";
      }
      setNewSessionPreferences((prev) =>
        prev
          ? {
              ...prev,
              workingDirByDevice: {
                ...prev.workingDirByDevice,
                [selectedDeviceId]: workingDir,
              },
              workspaceKindByDevice: {
                ...prev.workspaceKindByDevice,
                [selectedDeviceId]: "project",
              },
            }
          : prev,
      );
      return { deviceId: selectedDeviceId, workingDir };
    },
    [selectedDeviceId],
  );
  const chooseWorkingDir = useCallback(
    (workingDir: string) => {
      const remembered = rememberWorkingDirForDevice(workingDir);
      if (remembered)
        void saveNewSessionPreferences({ workingDirForDevice: remembered });
      selectWorkingDir(workingDir);
    },
    [rememberWorkingDirForDevice, selectWorkingDir],
  );
  const selectDialogueWorkspace = useCallback(() => {
    userTouchedWorkspaceRef.current = true;
    if (selectedDeviceId) {
      if (workspaceKindPreferenceOverridesRef) {
        workspaceKindPreferenceOverridesRef.current[selectedDeviceId] =
          "dialogue";
      }
      setNewSessionPreferences((prev) =>
        prev
          ? {
              ...prev,
              workspaceKindByDevice: {
                ...prev.workspaceKindByDevice,
                [selectedDeviceId]: "dialogue",
              },
            }
          : prev,
      );
    }
    void saveNewSessionPreferences({
      workspaceKind: "dialogue",
      ...(selectedDeviceId
        ? {
            workspaceKindForDevice: {
              deviceId: selectedDeviceId,
              workspaceKind: "dialogue",
            },
          }
        : {}),
    });
    patchDraft({ workspaceKind: "dialogue", workingDir: "" });
    setWorkspacePickerOpen(false);
    setBrowseOpen(false);
    setShowHiddenDirectories(false);
  }, [patchDraft, selectedDeviceId]);
  const selectRecentProject = useCallback(
    (workingDir: string) => {
      userTouchedWorkspaceRef.current = true;
      // 显式点选最近项目 = 该设备的目录记忆(#4103);设备未定时只记模式。
      const remembered = rememberWorkingDirForDevice(workingDir);
      void saveNewSessionPreferences({
        workspaceKind: "project",
        ...(remembered ? { workingDirForDevice: remembered } : {}),
      });
      patchDraft({ workspaceKind: "project", workingDir });
      setWorkspacePickerOpen(false);
      setBrowseOpen(false);
      setShowHiddenDirectories(false);
    },
    [patchDraft, rememberWorkingDirForDevice],
  );
  const openProjectBrowse = useCallback(() => {
    userTouchedWorkspaceRef.current = true;
    void saveNewSessionPreferences({ workspaceKind: "project" });
    patchDraft({ workspaceKind: "project" });
    setWorkspacePickerOpen(false);
    setBrowseOpen(true);
    // 用户显式选择浏览时,消费初始工作区决策,避免 auto-select effect 关掉浏览改选最近项目。
    initialWorkspaceKeyRef.current = `${selectedDeviceId}:${initialWorkingDir ?? ""}`;
    void loadBrowsePath(draft.workingDir.trim() || "~");
  }, [
    draft.workingDir,
    loadBrowsePath,
    patchDraft,
    selectedDeviceId,
    initialWorkingDir,
  ]);
  return {
    selectWorkingDir,
    rememberWorkingDirForDevice,
    chooseWorkingDir,
    selectDialogueWorkspace,
    selectRecentProject,
    openProjectBrowse,
  };
}

export interface NewSessionInitialWorkspaceInput extends Pick<
  WorkspaceIdentity,
  | "selectedDeviceId"
  | "draft"
  | "newSessionPreferencesLoaded"
  | "userTouchedWorkspaceRef"
  | "userTouchedDeviceRef"
  | "preferredDefaultDevice"
  | "initialWorkingDir"
  | "initialWorkspaceKeyRef"
  | "newSessionPreferences"
  | "newSessionDefaults"
  | "setBrowseOpen"
  | "loadBrowsePath"
> {
  browseOpen: boolean;
  recentWorkspaces: ReturnType<typeof buildRecentWorkspaceOptions>;
  /** 当前页来源：应用内 / 桌面小组件。决定读哪一份默认档案。 */
  originProfile: NewSessionDefaultProfileKey;
  patchDraft: (patch: Partial<NewSessionDraft>) => void;
}

/**
 * 先按来源档案的默认工作区落定；档案是「跟随上次」时再走原来的记忆链。
 * 只在默认电脑已落定、用户没手动选过工作区时执行；默认或设备变化会重新应用。
 */
export function useNewSessionInitialWorkspace(
  input: NewSessionInitialWorkspaceInput,
): void {
  const {
    selectedDeviceId,
    draft,
    newSessionPreferencesLoaded,
    userTouchedDeviceRef,
    preferredDefaultDevice,
    initialWorkingDir,
    initialWorkspaceKeyRef,
    recentWorkspaces,
    newSessionPreferences,
    newSessionDefaults,
    originProfile,
    patchDraft,
    browseOpen,
    setBrowseOpen,
    loadBrowsePath,
  } = input;
  // 设置弹窗保存后默认会变；换电脑仍要恢复那台电脑的记忆，但用户已经手动换过
  // 电脑时，不把新默认套用到当前这次新建上（Q10「未手动动过才立即生效」）。
  const workspaceTriggerRef = useRef<{ deviceId: string; defaultsKey: string } | null>(null);
  useEffect(() => {
    if (!selectedDeviceId || !newSessionPreferencesLoaded) return;
    // 用户已手动选过本次工作区时不再覆盖默认；但换电脑会清空目录，这时仍要
    // 恢复那台电脑的记忆（原逻辑同样在空目录时继续）。手动选的「对话」跨换电脑
    // 保留，不被另一台电脑的模式默认顶掉。
    if (
      input.userTouchedWorkspaceRef.current
      && (browseOpen || draft.workspaceKind === 'dialogue' || draft.workingDir.trim())
    )
      return;
    // 等默认设备同步完成再选工作区，避免借用上一台电脑的路径。
    if (
      !userTouchedDeviceRef.current &&
      selectedDeviceId !== preferredDefaultDevice?.deviceId
    )
      return;

    const defaults = newSessionDefaults ?? DEFAULT_NEW_SESSION_DEFAULTS;
    const defaultsKey = JSON.stringify(defaults);
    const previousTrigger = workspaceTriggerRef.current;
    const deviceChanged = !previousTrigger || previousTrigger.deviceId !== selectedDeviceId;
    const defaultsChanged = !previousTrigger || previousTrigger.defaultsKey !== defaultsKey;
    if (!deviceChanged && defaultsChanged && userTouchedDeviceRef.current) {
      workspaceTriggerRef.current = { deviceId: selectedDeviceId, defaultsKey };
      return;
    }
    workspaceTriggerRef.current = { deviceId: selectedDeviceId, defaultsKey };
    const decision = resolveNewSessionDefaultWorkspace({
      defaults,
      profile: originProfile,
      deviceId: selectedDeviceId,
      initialWorkingDir,
      followLastKind: newSessionPreferences?.workspaceKind ?? null,
      initialKind: initialWorkingDir ? 'project' : 'dialogue',
      rememberedWorkingDir: newSessionPreferences?.workingDirByDevice?.[selectedDeviceId] ?? null,
      recentWorkspaces,
    });
    // 键包含默认本身：弹窗改默认后能重新应用；最近项目后来重排不会反复改草稿。
    const key = [
      selectedDeviceId,
      initialWorkingDir ?? "",
      originProfile,
      JSON.stringify(defaults),
    ].join("\u0000");
    if (initialWorkspaceKeyRef.current === key) return;
    initialWorkspaceKeyRef.current = key;

    if (
      draft.workspaceKind !== decision.kind ||
      draft.workingDir !== decision.workingDir
    ) {
      patchDraft({ workspaceKind: decision.kind, workingDir: decision.workingDir });
    }
    if (decision.needsBrowse) {
      setBrowseOpen(true);
      void loadBrowsePath("~");
      return;
    }
    setBrowseOpen(false);
  }, [
    selectedDeviceId,
    draft.workspaceKind,
    draft.workingDir,
    browseOpen,
    initialWorkingDir,
    loadBrowsePath,
    recentWorkspaces,
    patchDraft,
    setBrowseOpen,
    newSessionPreferencesLoaded,
    newSessionPreferences?.workingDirByDevice,
    newSessionPreferences?.workspaceKind,
    newSessionDefaults,
    originProfile,
    preferredDefaultDevice?.deviceId,
    input.userTouchedWorkspaceRef,
  ]);
}
