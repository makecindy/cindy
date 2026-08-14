export type PiPackageResourceKind = 'extension' | 'skill' | 'prompt' | 'theme';

export type PiPackageCompatibility = 'supported' | 'partial' | 'unsupported' | 'unknown';

export type PiPackageCompatibilityIssue =
  | 'interactive-dialogs'
  | 'notifications'
  | 'status-display'
  | 'widgets'
  | 'terminal-title'
  | 'editor-integration'
  | 'tui-layout'
  | 'custom-ui'
  | 'theme-control'
  | 'terminal-input'
  | 'tui-rendering'
  | 'cli-flags'
  | 'analysis-incomplete';

export type PiExtensionUiApi =
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'notify'
  | 'setStatus'
  | 'setWorkingMessage'
  | 'setWorkingVisible'
  | 'setWorkingIndicator'
  | 'setHiddenThinkingLabel'
  | 'setWidget'
  | 'setTitle'
  | 'setEditorText'
  | 'getEditorText'
  | 'pasteToEditor'
  | 'getEditorComponent'
  | 'addAutocompleteProvider'
  | 'setEditorComponent'
  | 'setFooter'
  | 'setHeader'
  | 'setToolsExpanded'
  | 'getToolsExpanded'
  | 'custom'
  | 'getAllThemes'
  | 'getTheme'
  | 'setTheme'
  | 'theme'
  | 'onTerminalInput'
  | 'registerShortcut'
  | 'registerFlag'
  | 'registerMessageRenderer'
  | 'registerMarkdownTransformer'
  | 'registerEntryRenderer';

export interface PiPackageResourceView {
  kind: PiPackageResourceKind;
  name: string;
  compatibility: PiPackageCompatibility;
  compatibilityIssues?: PiPackageCompatibilityIssue[];
  detectedApis?: PiExtensionUiApi[];
}

export interface PiPackageRuntimeRequirement {
  packageName: string;
  range: string;
  currentVersion?: string;
  compatible: boolean | null;
  reason?: 'legacy-runtime-package';
}

export interface PiPackageView {
  source: string;
  name: string;
  version?: string;
  enabled: boolean;
  /** False when Cindy must not send this persisted source back to Pi. */
  manageable?: false;
  /** Extension code stays disabled until the user explicitly accepts full Pi-process access. */
  requiresExtensionApproval?: boolean;
  resources: PiPackageResourceView[];
  runtimeRequirements?: PiPackageRuntimeRequirement[];
  warning?:
    | 'no-resources'
    | 'inspection-failed'
    | 'inspection-limit'
    | 'unsupported-filter'
    | 'unsafe-source'
    | 'lifecycle-scripts-disabled';
}

export interface PiPackageListResult {
  available: boolean;
  packages: PiPackageView[];
}

export type PiPackageMutationAction = 'install' | 'remove' | 'update' | 'set-enabled';

export interface PiPackageMutationRequest {
  action: PiPackageMutationAction;
  source: string;
  /** Renderer confirmation that arbitrary third-party extension code may run. */
  confirmed?: boolean;
  enabled?: boolean;
}

export interface PiPackageMutationResult extends PiPackageListResult {
  changed: boolean;
  affectedPackage?: PiPackageView;
}

export function hasPiPackageCompatibilityWarning(pkg: PiPackageView): boolean {
  return pkg.warning !== undefined
    || pkg.resources.some((resource) => resource.compatibility !== 'supported')
    || pkg.runtimeRequirements?.some((requirement) => requirement.compatible !== true) === true;
}

export function shouldShowPiPackagePostMutationNotice(pkg: PiPackageView): boolean {
  return pkg.requiresExtensionApproval === true || hasPiPackageCompatibilityWarning(pkg);
}

export interface PiPackageSlashCommand {
  kind: 'agent-builtin';
  name: string;
  description: string;
}

export type PiPackageCommandRuntimeStatus =
  | 'pending'
  | 'loaded'
  | 'failed'
  | 'unknown';

/** Runtime-confirmed Pi package commands belong only to the Pi command palette. */
export function mergePiPackageCommands(
  agentKind: 'claude-code' | 'codex' | 'pi',
  builtins: PiPackageSlashCommand[],
  packageCommands: Array<{ name: string; description: string }>,
): PiPackageSlashCommand[] {
  if (agentKind !== 'pi') return builtins;
  const names = new Set(builtins.map((command) => command.name.toLowerCase()));
  return [
    ...builtins,
    ...packageCommands.flatMap((command) => {
      const key = command.name.toLowerCase();
      if (!command.name || names.has(key)) return [];
      names.add(key);
      return [{ kind: 'agent-builtin' as const, ...command }];
    }),
  ];
}

export function shouldListPiPackageCommands(
  requestedAgentKind: 'claude-code' | 'codex' | 'pi',
  sessionIdProvided: boolean,
  session: {
    agentKind: 'claude-code' | 'codex' | 'pi';
    reviewMode?: true;
    remoteHostId?: string;
  } | null,
  allowUnboundLocalPreview = true,
): boolean {
  if (requestedAgentKind !== 'pi') return false;
  // New local Pi task: there is no session yet, so the Cindy-owned local
  // package roster is the correct preview.
  if (!sessionIdProvided) return allowUnboundLocalPreview;
  // Existing tasks must be proven local, ordinary Pi tasks by host-owned
  // metadata. Missing/mismatched metadata fails closed.
  return session?.agentKind === 'pi' && session.reviewMode !== true && !session.remoteHostId;
}
