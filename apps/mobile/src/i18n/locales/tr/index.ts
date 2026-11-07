import mcpApps from './mcpApps.json';
import plugins from './plugins.json';
import taskTags from './taskTags.json';
import apiErrors from './apiErrors.json';
import remoteDesktop from './remoteDesktop.json';
import chat from './chat.json';
import composer from './composer.json';
import deviceLink from './deviceLink.json';
import devices from './devices.json';
import files from './files.json';
import groupChat from './groupChat.json';
import home from './home.json';
import interaction from './interaction.json';
import message from './message.json';
import models from './models.json';
import providerShare from './providerShare.json';
import relay from './relay.json';
import session from './session.json';
import sharedTask from './sharedTask.json';
import settings from './settings.json';
import shared from './shared.json';
import startup from './startup.json';
import update from './update.json';

export default {
  mcpApps,
  plugins,
  taskTags,
  remoteDesktop,
  apiErrors,
  chat,
  composer,
  deviceLink,
  devices,
  files,
  groupChat,
  home,
  interaction,
  message,
  models,
  providerShare,
  relay,
  session,
  sharedTask,
  settings,
  shared,
  startup,
  update,
} as const;
