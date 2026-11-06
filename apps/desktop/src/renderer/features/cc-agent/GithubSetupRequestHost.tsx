import { useEffect, useState } from 'react';
import { GithubSetupDialog } from './GithubSetupDialog';

/**
 * Opens Cindy's GitHub sign-in dialog when main asks this window to (a task requested to connect a
 * plugin that signs in through this computer's GitHub login, and nothing is signed in). Main sends the
 * request to one window only, so whichever window receives it shows the dialog.
 */
export function GithubSetupRequestHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => window.electronAPI.gitContext?.onGithubSetupOpen?.(() => setOpen(true)), []);
  return open ? <GithubSetupDialog onClose={() => setOpen(false)} /> : null;
}
