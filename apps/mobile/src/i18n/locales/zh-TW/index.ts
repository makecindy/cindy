/**
 * 本 locale 的 catalog 组装:每个区域一个 JSON 文件、一个顶级 key,
 * 组装成单一 'common' namespace 的资源对象。
 * 区域清单四语必须一致(与其余 locale 的 index.ts 逐行同构);新增区域时
 * 四个 locales/<locale>/index.ts 一起加,平价测试会拦截漏改。
 */

import apiErrors from './apiErrors.json';
import composer from './composer.json';
import deviceLink from './deviceLink.json';
import devices from './devices.json';
import files from './files.json';
import home from './home.json';
import interaction from './interaction.json';
import message from './message.json';
import models from './models.json';
import session from './session.json';
import settings from './settings.json';
import shared from './shared.json';
import startup from './startup.json';
import update from './update.json';

export default {
  apiErrors,
  composer,
  deviceLink,
  devices,
  files,
  home,
  interaction,
  message,
  models,
  session,
  settings,
  shared,
  startup,
  update,
} as const;
