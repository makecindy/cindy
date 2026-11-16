import { app } from 'electron';
// LaunchServices starts at /. Match Forge's normal working directory before
// importing modules that resolve developer resources relative to cwd.
if (process.platform === 'darwin' && !app.isPackaged && process.env.CINDY_PERSONAL_LAUNCH_SERVICES === '1') {
  process.chdir(app.getAppPath());
}
