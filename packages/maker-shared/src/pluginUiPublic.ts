/** Author-facing types. No Host view bindings, transport or platform imports. */
export type PluginAppearanceField = 'wallpaper' | 'uiFont' | 'codeFont' | 'bodyFont' | 'theme' | 'reading' | 'contentStyle' | 'appIcon';
export type PluginAppearanceColor = 'text' | 'secondaryText' | 'surface' | 'border' | 'userBubble' | 'userText' | 'assistantBubble';
/** asset:<declared id>, library:<owned relative path>, or an owned cindy-media reference. */
export type PluginAppearanceResource = string;
export interface PluginAppearanceFont {
  family?: string;
  size?: number;
  resource?: PluginAppearanceResource;
  weight?: number;
  style?: 'normal' | 'italic';
}
export interface PluginAppearancePatch {
  /** Runtime Dock/window icon. Does not change the installed application's icon. */
  appIcon?: { resource: PluginAppearanceResource };
  uiFont?: PluginAppearanceFont;
  codeFont?: PluginAppearanceFont;
  bodyFont?: PluginAppearanceFont;
  wallpaper?: { resource?: PluginAppearanceResource; fallbackResource?: PluginAppearanceResource;
    visibility?: number; blur?: number; motion?: 'static' | 'dynamic' };
  theme?: { light?: Partial<Record<PluginAppearanceColor, string>>; dark?: Partial<Record<PluginAppearanceColor, string>> };
  reading?: { bodyLineHeight?: number; codeLineHeight?: number; maxWidth?: number };
  contentStyle?: { messageGap?: number; messagePadding?: number; messageRadius?: number };
}
export interface PluginAppearanceSnapshot { revision: string; values: PluginAppearancePatch }
export interface PluginAppearanceResult extends PluginAppearanceSnapshot {
  /** saved means no viewing window confirmed application; it does not mean visible success. */
  application: { status: 'applied' | 'saved' | 'failed'; reason?: string };
}
export interface CindyPluginAppearance {
  read(): Promise<PluginAppearanceSnapshot>;
  set(patch: PluginAppearancePatch, options?: { ifRevision?: string }): Promise<PluginAppearanceResult>;
  reset(fields: PluginAppearanceField[], options?: { ifRevision?: string }): Promise<PluginAppearanceResult>;
}

/** The current Desktop window's named interface areas. */
export type PluginUiVisibilityElement = 'workspace' | 'sidebar' | 'header' | 'messages' | 'composer' | 'tools' | 'windowControls';
export type PluginUiVisibilityValues = Record<PluginUiVisibilityElement, boolean>;
export interface PluginUiVisibilityResult {
  values: PluginUiVisibilityValues;
  application: { status: 'applied' | 'unconfirmed' };
}
export interface CindyPluginUiVisibility {
  read(): Promise<PluginUiVisibilityValues>;
  set(patch: Partial<PluginUiVisibilityValues>): Promise<PluginUiVisibilityResult>;
}

export type PluginUiScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'message'; sessionId: string; messageClientId: string }
  | { kind: 'tool'; sessionId: string; toolUseId: string };

export interface PluginUiCapabilities {
  version: 1;
  points: string[];
  primitives: string[];
  effects: string[];
  pages: string[];
  tabViews?: boolean;
}

export interface PluginUiContext {
  scope: PluginUiScope;
  capabilities: PluginUiCapabilities;
  session?: { id: string; title: string; status: string; agentKind?: string };
  message?: { id: string; role: 'user' | 'assistant'; text: string };
  tool?: { id: string; name: string; input?: unknown; result?: string; status?: string };
  /** Only supplied for the explicit action that captured this selection. */
  selection?: { text: string };
}
export interface PluginUiComposerEdit { operation: 'append' | 'replace-selection'; text: string }
export type PluginUiValues = Record<string, string | number | boolean | string[]>;
/** Plugin-owned JSON, passed through without becoming Host state or effects. */
export type PluginUiData = null | string | number | boolean | PluginUiData[] | { [key: string]: PluginUiData };
export interface PluginUiOpenView { id: string; params?: PluginUiValues }
export interface PluginUiTabViewSnapshot {
  id: string;
  scope: { kind: 'global' } | { kind: 'session'; sessionId: string };
  params: PluginUiValues;
  generation: string;
  visible: boolean;
}
/** Injected into a registered tab's packaged page, without general Host IPC. */
export interface CindyPluginTabView {
  read(): Promise<PluginUiTabViewSnapshot>;
  onChanged(listener: (snapshot: PluginUiTabViewSnapshot) => void): () => void;
}
export interface PluginUiNavigationResult {
  tab: 'opened' | 'unavailable' | 'superseded';
  page: 'received' | 'unconfirmed';
}

interface ControlBase { id: string; label: string; disabled?: boolean; required?: boolean }
export type PluginUiControl =
  | (ControlBase & { kind: 'button'; actionId: string })
  | (ControlBase & { kind: 'select'; value: string; actionId: string; options: { value: string; label: string }[] })
  | (ControlBase & { kind: 'status'; text: string });

export type PluginUiBlock = { kind: 'markdown'; id: string; text: string };
export interface PluginUiAction { id: string; label: string; disabled?: boolean }
export interface PluginUiContent {
  controls: PluginUiControl[];
  blocks: PluginUiBlock[];
  actions: PluginUiAction[];
  fallbackMarkdown: string;
}

export type PluginUiActionResult = {
  status: 'completed' | 'rejected' | 'outcome-unknown';
  reason?: string;
  data?: PluginUiData;
  edit?: PluginUiComposerEdit;
  openView?: PluginUiOpenView;
};
export interface PluginUiActionInput {
  actionId: string;
  values: PluginUiValues;
  data?: PluginUiData;
  context: PluginUiContext;
}
/** Available inside a contribution's isolated page, bound to its current view. */
export interface CindyPluginUiPage {
  read(): Promise<PluginUiContext>;
  capabilities(): Promise<PluginUiCapabilities>;
  invoke(input: { actionId: string; values: PluginUiActionInput['values']; data?: PluginUiData }): Promise<
    Omit<PluginUiActionResult, 'edit' | 'openView'> & {
      effectError?: 'UNSUPPORTED_EFFECT'; navigation?: PluginUiNavigationResult; navigationError?: 'VIEW_UNAVAILABLE'
    }
  >;
  appearance: CindyPluginAppearance;
  visibility: CindyPluginUiVisibility;
}
export interface PluginUiContributionHandler {
  render(context: PluginUiContext): PluginUiContent | Promise<PluginUiContent>;
  onAction?(input: PluginUiActionInput): PluginUiActionResult | Promise<PluginUiActionResult>;
}
export type PluginUiCommandHandler = (context: PluginUiContext) => PluginUiActionResult | Promise<PluginUiActionResult>;
export interface CindyPluginUi {
  appearance: CindyPluginAppearance;
  visibility: CindyPluginUiVisibility;
  contribute(id: string, handler: PluginUiContributionHandler): () => void;
  registerCommand(id: string, handler: PluginUiCommandHandler): () => void;
  invalidate(input: { contributionId: string; scope: PluginUiScope }): void;
  capabilities(): Promise<PluginUiCapabilities>;
  dispose(): void;
}
