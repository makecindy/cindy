import {
  useCallback,
  useEffect,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  pickInitialNewSessionWorkspace,
  type NewSessionDeviceOption,
  type NewSessionDraft,
  type NewSessionStoredPreferences,
  type buildRecentWorkspaceOptions,
} from "./newSession";
import {
  readNewSessionPreferences,
  saveNewSessionPreferences,
} from "./newSessionPreferenceStore";
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
  newSessionPreferences: NewSessionStoredPreferences | null;
  newSessionPreferencesLoaded: boolean;
  preferredDefaultDevice: NewSessionDeviceOption | null;
  setNewSessionPreferences: Setter<NewSessionStoredPreferences | null>;
  setBrowseOpen: Setter<boolean>;
  loadBrowsePath: (path: string) => Promise<void>;
}

export interface NewSessionWorkspacePreferencesInput extends Pick<
  WorkspaceIdentity,
  | "initialWorkingDir"
  | "newSessionPreferences"
  | "newSessionPreferencesLoaded"
  | "workingDirPreferenceOverridesRef"
  | "userTouchedWorkspaceRef"
  | "userTouchedDeviceRef"
  | "preferredDefaultDevice"
  | "setNewSessionPreferences"
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
}

/** The initial async preference read never replaces a choice made in this form. */
export function useNewSessionWorkspacePreferences(
  input: NewSessionWorkspacePreferencesInput,
): void {
  const {
    newSessionPreferences,
    setNewSessionPreferences,
    newSessionPreferencesLoaded,
    setNewSessionPreferencesLoaded,
    workingDirPreferenceOverridesRef,
    initialWorkingDir,
    userTouchedWorkspaceRef,
    setDraft,
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
  useEffect(() => {
    let cancelled = false;
    setNewSessionPreferencesLoaded(false);
    void readNewSessionPreferences()
      .then((preferences) => {
        if (cancelled) return;
        // A late initial read must not replace directories explicitly chosen while it was pending.
        setNewSessionPreferences({
          ...preferences,
          workingDirByDevice: {
            ...preferences.workingDirByDevice,
            ...workingDirPreferenceOverridesRef.current,
          },
        });
        const workspaceKind = preferences.workspaceKind;
        if (!initialWorkingDir && workspaceKind) {
          setDraft((current) =>
            userTouchedWorkspaceRef.current
              ? current
              : { ...current, workspaceKind },
          );
        }
      })
      .finally(() => {
        if (!cancelled) setNewSessionPreferencesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!newSessionPreferencesLoaded) return;
    if (userTouchedDeviceRef.current) return;
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
    newSessionPreferencesLoaded,
    preferredDefaultDevice?.deviceId,
    preferredDefaultDevice?.name,
    routeDeviceExplicit,
    routeDeviceId,
    routeDeviceName,
  ]);
}

export interface NewSessionWorkspaceActionsInput extends Pick<
  WorkspaceIdentity,
  | "draft"
  | "selectedDeviceId"
  | "initialWorkingDir"
  | "setBrowseOpen"
  | "workingDirPreferenceOverridesRef"
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
      setNewSessionPreferences((prev) =>
        prev
          ? {
              ...prev,
              workingDirByDevice: {
                ...prev.workingDirByDevice,
                [selectedDeviceId]: workingDir,
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
    void saveNewSessionPreferences({ workspaceKind: "dialogue" });
    patchDraft({ workspaceKind: "dialogue", workingDir: "" });
    setWorkspacePickerOpen(false);
    setBrowseOpen(false);
    setShowHiddenDirectories(false);
  }, [patchDraft]);
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
  | "userTouchedDeviceRef"
  | "preferredDefaultDevice"
  | "initialWorkingDir"
  | "initialWorkspaceKeyRef"
  | "newSessionPreferences"
  | "setBrowseOpen"
  | "loadBrowsePath"
> {
  recentWorkspaces: ReturnType<typeof buildRecentWorkspaceOptions>;
  selectWorkingDir: (path: string) => void;
}

/** Apply the initial directory only after the default computer has settled. */
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
    selectWorkingDir,
    setBrowseOpen,
    loadBrowsePath,
  } = input;
  useEffect(() => {
    if (
      !selectedDeviceId ||
      draft.workspaceKind !== "project" ||
      draft.workingDir.trim()
    )
      return;
    // 恢复项目模式后，等默认设备同步完成再选目录，避免借用上一台电脑的路径。
    if (!newSessionPreferencesLoaded) return;
    if (
      !userTouchedDeviceRef.current &&
      selectedDeviceId !== preferredDefaultDevice?.deviceId
    )
      return;

    const key = `${selectedDeviceId}:${initialWorkingDir ?? ""}`;
    if (initialWorkspaceKeyRef.current === key) return;
    initialWorkspaceKeyRef.current = key;

    // 先用该设备记住的上次显式选择(#4103),没有再取最近项目首项。
    const initialWorkspace = pickInitialNewSessionWorkspace(
      draft.workingDir,
      recentWorkspaces,
      newSessionPreferences?.workingDirByDevice?.[selectedDeviceId] ?? null,
    );
    if (initialWorkspace) {
      selectWorkingDir(initialWorkspace);
      return;
    }

    setBrowseOpen(true);
    void loadBrowsePath("~");
  }, [
    selectedDeviceId,
    draft.workspaceKind,
    draft.workingDir,
    initialWorkingDir,
    loadBrowsePath,
    recentWorkspaces,
    selectWorkingDir,
    newSessionPreferencesLoaded,
    newSessionPreferences?.workingDirByDevice,
    preferredDefaultDevice?.deviceId,
  ]);
}
