// Isolated native fixture: copies current production code, never credentials/account data.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const out=path.join(root,'.build/quota-widget-android-fixture');
const production=path.join(root,'apps/mobile/modules/cindy-quota-widget/android/src/main');
const java='java/expo/modules/cindyquotawidget';
fs.mkdirSync(path.join(out,'src/main',java),{recursive:true});
fs.mkdirSync(path.join(out,'src/production/expo/modules/cindyquotawidget'),{recursive:true});
for(const name of ['build.gradle','settings.gradle'])fs.copyFileSync(path.join(here,name),path.join(out,name));
fs.copyFileSync(path.join(here,'AndroidManifest.xml'),path.join(out,'src/main/AndroidManifest.xml'));
fs.copyFileSync(path.join(here,'FixtureActivity.kt'),path.join(out,'src/main',java,'FixtureActivity.kt'));
fs.cpSync(path.join(production,'res'),path.join(out,'src/main/res'),{recursive:true});
for(const name of ['QuotaSnapshot','QuotaWidgetMetrics','QuotaWidgetPresentation','QuotaWidgetProvider'])
 fs.copyFileSync(path.join(production,java,name+'.kt'),path.join(out,'src/production/expo/modules/cindyquotawidget',name+'.kt'));
console.log(out);
