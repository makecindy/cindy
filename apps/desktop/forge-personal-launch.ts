import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import type { StartOptions, StartResult } from '@electron-forge/shared-types';

/** Normal builds keep Forge's launch; native personal builds need LaunchServices. */
export class PersonalNativeLaunchPlugin extends AutoUnpackNativesPlugin {
  override async startLogic(options: StartOptions): Promise<StartResult> {
    const receipt = path.join(options.dir, 'resources/personal-native.json');
    if (process.platform !== 'darwin' || !process.env.CINDY_PERSONAL_MONITOR_DIR || !fs.existsSync(receipt)) return false;
    if (JSON.parse(fs.readFileSync(receipt, 'utf8')).state !== 'built') return false;
    if (options.runAsNode || options.inspect || options.inspectBrk) throw new Error('Use the ordinary dev launcher for native debugging');
    const executable = createRequire(path.join(options.dir, 'package.json'))('electron') as string;
    return [process.execPath, path.resolve(options.dir, '../../scripts/personal-build/macos-app-launch.mjs'), path.resolve(executable, '../../..')];
  }
}
