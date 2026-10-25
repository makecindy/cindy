import { createLogger } from '../logger.js';
import { setFsBrowseLogger } from '@cindy/remote-agent/fsBrowse/windowsDrives';
setFsBrowseLogger(createLogger('fsBrowse/windowsDrives'));
export * from '@cindy/remote-agent/fsBrowse/windowsDrives';
