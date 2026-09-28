export interface NewTaskSelectionSheetProps {
  page: 'device' | 'workspace' | 'directory' | null;
  busy: boolean;
  devices: readonly { deviceId: string; name?: string }[];
  selectedDeviceId: string;
  workspaces: readonly { title: string; workingDir: string }[];
  workspaceKind: string;
  workingDir: string;
  path: string;
  parent: string | null;
  /** Windows 被控端的盘符切换项;少于两个时为空,不显示。 */
  drives: readonly { name: string; path: string; current: boolean }[];
  entries: readonly { name: string; path: string }[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  onClose(): void;
  onBack(): void;
  onDevice(id: string): void;
  onDialogue(): void;
  onProject(path: string): void;
  onBrowse(): void;
  onEnter(path: string): void;
  onChoose(path: string): void;
  onShowHidden(value: boolean): void;
}

// Android retains its existing selection and directory controls.
export function NewTaskSelectionSheet(_props: NewTaskSelectionSheetProps) {
  return null;
}
