import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import type { StartOptions, StartResult } from '@electron-forge/shared-types';

/** Normal builds keep Forge's launch; native personal builds need LaunchServices. */
export class PersonalNativeLaunchPlugin extends AutoUnpackNativesPlugin {
  override async startLogic(options: StartOptions): Promise<StartResult> {
    const receipt = path.join(options.dir, 'resources/personal-native.json');
    if (process.platform !== 'darwin' || !fs.existsSync(receipt)) return false;
    const native = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (native.state !== 'built' || (!native.runtime && !process.env.CINDY_PERSONAL_MONITOR_DIR)) return false;
    if (options.runAsNode || options.inspect || options.inspectBrk) throw new Error('Use the ordinary dev launcher for native debugging');
    const executable = createRequire(path.join(options.dir, 'package.json'))('electron') as string;
    return [process.execPath, path.resolve(options.dir, '../../scripts/personal-build/macos-app-launch.mjs'), native.runtime ? path.join(native.runtime.directory, 'Cindy.app') : path.resolve(executable, '../../..')];
  }
}
