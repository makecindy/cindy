import {
  captureLocalProjectContext,
  registerLocalProjectDirectory,
} from './mcp-integrations/createProject.js';

/** Native selection and registration share one captured owner, including across the dialog await. */
export async function pickProjectDirectory(
  showDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  registerProject = false,
): Promise<{ canceled: boolean; path?: string }> {
  const context = registerProject ? captureLocalProjectContext() : null;
  const result = await showDialog();
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  if (!context) return { canceled: false, path: result.filePaths[0] };
  context.assertCurrent();
  const registered = await registerLocalProjectDirectory(context, result.filePaths[0]);
  if (!registered.ok) throw new Error(registered.message);
  context.assertCurrent();
  return { canceled: false, path: registered.workingDir };
}
