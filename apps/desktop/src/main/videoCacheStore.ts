import {app} from 'electron';
import {createLegacyVideoCache} from '@cindy/app-runtime/media/legacyVideoCache';
export const {resolveSafe,readFile,streamFile,getVideosDir,saveLiziArtVideo}=createLegacyVideoCache(()=>app.getPath('userData'));
