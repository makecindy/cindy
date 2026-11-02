/** Compatibility view for ghost_forge_guide. Authoring docs live only in the built-in Skill.
 * Raw imports embed the same shipped Markdown in dev, tests and packaged builds.
 */
import overview from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-overview.md?raw';
import sourceVerification from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-source-verification.md?raw';
import routineEvents from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-routine-events.md?raw';
import design from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-design.md?raw';
import structure from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-structure.md?raw';
import manifest from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-manifest.md?raw';
import tools from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-tools.md?raw';
import toolDiscovery from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-tool-discovery.md?raw';
import manual from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-manual.md?raw';
import runtime from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-runtime.md?raw';
import agentModels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-models.md?raw';
import media from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-media.md?raw';
import hostContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-host-context.md?raw';
import agentCallContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-call-context.md?raw';
import chatCards from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-chat-cards.md?raw';
import eventSubscriptions from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-event-subscriptions.md?raw';
import messageHooks from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-message-hooks.md?raw';
import controlPoints from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-control-points.md?raw';
import pluginModels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-models.md?raw';
import network from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-network.md?raw';
import settings from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-settings.md?raw';
import notifications from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-notifications.md?raw';
import filesAndLibrary from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-files-and-library.md?raw';
import agentTasks from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-agent-tasks.md?raw';
import interactivePages from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-interactive-pages.md?raw';
import nodeWorker from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-node-worker.md?raw';
import sessionContext from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-session-context.md?raw';
import directoryPicker from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-directory-picker.md?raw';
import panelPreview from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-panel-preview.md?raw';
import browserExtension from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-browser-extension.md?raw';
import bundledSkillsLegacy from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-bundled-skills-legacy.md?raw';
import workspaceSessions from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-workspace-sessions.md?raw';
import confirmDialog from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-confirm-dialog.md?raw';
import mainView from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-main-view.md?raw';
import taskView from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-task-view.md?raw';
import recommendations from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-recommendations.md?raw';
import panels from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-panels.md?raw';
import mobilePages from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-mobile-pages.md?raw';
import sandbox from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-sandbox.md?raw';
import packaging from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-packaging.md?raw';
import publishing from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-publishing.md?raw';
import compatibility from '../../../resources/system-skills/cindy-plugin-creator/references/plugin-compatibility.md?raw';

export const FORGE_GUIDE = [
  overview,
  sourceVerification,
  routineEvents,
  design,
  structure,
  manifest,
  tools,
  toolDiscovery,
  manual,
  runtime,
  agentModels,
  media,
  hostContext,
  agentCallContext,
  chatCards,
  eventSubscriptions,
  messageHooks,
  controlPoints,
  pluginModels,
  network,
  settings,
  notifications,
  filesAndLibrary,
  agentTasks,
  nodeWorker,
  sessionContext,
  directoryPicker,
  panelPreview,
  browserExtension,
  bundledSkillsLegacy,
  workspaceSessions,
  confirmDialog,
  mainView,
  taskView,
  recommendations,
  interactivePages,
  panels,
  mobilePages,
  sandbox,
  packaging,
  publishing,
  compatibility,
].join('\n');
