// The standalone updater does not load the Electron renderer's i18next runtime.
const RETRY_COPY = {
  'zh-CN': {
    retry: '重试',
    processes_running: '请先关闭 Cindy 及从安装目录运行的其他进程，再重试',
    updater_busy: '另一项更新正在进行，请关闭此窗口后重新检查更新',
    in_progress: '更新重试已在进行中',
    unavailable: '当前更新失败不可重试',
    archive_unavailable: '更新文件已不存在或无法读取，请重新检查更新',
    spawn_failed: '无法启动重试更新，请关闭此窗口后重新检查更新',
  },
  'zh-TW': {
    retry: '重試',
    processes_running: '請先關閉 Cindy 及從安裝目錄執行的其他程序，再重試',
    updater_busy: '另一項更新正在進行，請關閉此視窗後重新檢查更新',
    in_progress: '更新重試已在進行中',
    unavailable: '目前的更新失敗無法重試',
    archive_unavailable: '更新檔案已不存在或無法讀取，請重新檢查更新',
    spawn_failed: '無法啟動更新重試，請關閉此視窗後重新檢查更新',
  },
  "es": {
    "retry": "Reintentar",
    "processes_running": "Cierra Cindy y todos los procesos que se ejecuten desde su carpeta de instalación y vuelve a intentarlo",
    "updater_busy": "Ya hay otra actualización en curso. Cierra esta ventana y vuelve a buscar actualizaciones",
    "in_progress": "Ya hay un reintento de actualización en curso",
    "unavailable": "No se puede reintentar esta actualización fallida",
    "archive_unavailable": "El archivo de actualización falta o no se puede leer. Vuelve a buscar actualizaciones",
    "spawn_failed": "No se pudo reiniciar el actualizador. Cierra esta ventana y vuelve a buscar actualizaciones"
  },
  "fr": {
    "retry": "Réessayer",
    "processes_running": "Fermez Cindy et tous les processus exécutés depuis son dossier d’installation, puis réessayez",
    "updater_busy": "Une autre mise à jour est déjà en cours. Fermez cette fenêtre et recherchez à nouveau les mises à jour",
    "in_progress": "Une nouvelle tentative de mise à jour est déjà en cours",
    "unavailable": "Cette mise à jour ne peut pas être retentée après cet échec",
    "archive_unavailable": "Le fichier de mise à jour est manquant ou illisible. Recherchez à nouveau les mises à jour",
    "spawn_failed": "Impossible de redémarrer le programme de mise à jour. Fermez cette fenêtre et recherchez à nouveau les mises à jour"
  },
  "de": {
    "retry": "Wiederholen",
    "processes_running": "Schließe Cindy und alle Prozesse, die aus dem Installationsordner ausgeführt werden, und versuche es erneut",
    "updater_busy": "Ein anderes Update läuft bereits. Schließe dieses Fenster und suche erneut nach Updates",
    "in_progress": "Ein erneuter Updateversuch läuft bereits",
    "unavailable": "Dieses fehlgeschlagene Update kann nicht erneut versucht werden",
    "archive_unavailable": "Die Updatedatei fehlt oder ist nicht lesbar. Suche bitte erneut nach Updates",
    "spawn_failed": "Das Updateprogramm konnte nicht neu gestartet werden. Schließe dieses Fenster und suche erneut nach Updates"
  },
  "pt-PT": {
    "retry": "Repetir",
    "processes_running": "Feche o Cindy e quaisquer processos em execução a partir da respetiva pasta de instalação e tente novamente",
    "updater_busy": "Já está outra atualização em curso. Feche esta janela e volte a procurar atualizações",
    "in_progress": "Já está em curso uma nova tentativa de atualização",
    "unavailable": "Não é possível repetir esta atualização após a falha",
    "archive_unavailable": "O ficheiro de atualização está em falta ou não pode ser lido. Volte a procurar atualizações",
    "spawn_failed": "Não foi possível reiniciar o atualizador. Feche esta janela e volte a procurar atualizações"
  },
  "pt-BR": {
    "retry": "Tentar novamente",
    "processes_running": "Feche o Cindy e todos os processos em execução na pasta de instalação e tente novamente",
    "updater_busy": "Outra atualização já está em andamento. Feche esta janela e verifique se há atualizações novamente",
    "in_progress": "Uma nova tentativa de atualização já está em andamento",
    "unavailable": "Não é possível tentar novamente após esta falha de atualização",
    "archive_unavailable": "O arquivo de atualização está ausente ou não pode ser lido. Verifique se há atualizações novamente",
    "spawn_failed": "Não foi possível reiniciar o atualizador. Feche esta janela e verifique se há atualizações novamente"
  },
  'zh-Hant-x-lzh': {
    retry: '再試',
    processes_running: '請先關閉 Cindy 及自安裝目錄執行之他程序，而後再試',
    updater_busy: '另有更新方行，請闔此視窗，再檢查更新',
    in_progress: '更新之重試已在進行',
    unavailable: '此番更新未成，不可重試',
    archive_unavailable: '更新檔案已不存或不可讀，請再檢查更新',
    spawn_failed: '未能啟動更新重試，請闔此視窗，再檢查更新',
  },
  'zh-Hans-x-lzh': {
    retry: '再试',
    processes_running: '请先关闭 Cindy 及自安装目录运行之他进程，而后再试',
    updater_busy: '另有更新方行，请阖此窗口，再检查更新',
    in_progress: '更新之重试已在进行',
    unavailable: '此番更新未成，不可重试',
    archive_unavailable: '更新文件已不存或不可读，请再检查更新',
    spawn_failed: '未能启动更新重试，请阖此窗口，再检查更新',
  },
  en: {
    retry: 'Retry',
    processes_running:
      'Close Cindy and any processes running from its installation folder, then retry',
    updater_busy:
      'Another update is already running. Close this window and check for updates again',
    in_progress: 'An update retry is already in progress',
    unavailable: 'This update failure cannot be retried',
    archive_unavailable: 'The update file is missing or unreadable. Please check for updates again',
    spawn_failed: 'Could not restart the updater. Close this window and check for updates again',
  },
  ja: {
    retry: '再試行',
    processes_running:
      'Cindy とインストール先から実行中の他のプロセスを終了してから、再試行してください',
    updater_busy:
      '別の更新が進行中です。このウィンドウを閉じて、更新を再度確認してください',
    in_progress: '更新の再試行はすでに進行中です',
    unavailable: 'この更新エラーは再試行できません',
    archive_unavailable: '更新ファイルが見つからないか、読み取れません。更新を再度確認してください',
    spawn_failed:
      '更新の再試行を開始できません。このウィンドウを閉じて、更新を再度確認してください',
  },
  ko: {
    retry: '다시 시도',
    processes_running:
      'Cindy 및 설치 폴더에서 실행 중인 다른 프로세스를 종료한 후 다시 시도해 주세요',
    updater_busy:
      '다른 업데이트가 이미 진행 중입니다. 이 창을 닫고 업데이트를 다시 확인해 주세요',
    in_progress: '업데이트 재시도가 이미 진행 중입니다',
    unavailable: '이 업데이트 오류는 다시 시도할 수 없습니다',
    archive_unavailable: '업데이트 파일이 없거나 읽을 수 없습니다. 업데이트를 다시 확인해 주세요',
    spawn_failed:
      '업데이트 재시도를 시작할 수 없습니다. 이 창을 닫고 업데이트를 다시 확인해 주세요',
  },
};

globalThis.retryCopy = function retryCopy(language = 'en') {
  const locale = language.toLowerCase();
  if (/^zh-hant-x-lzh$/.test(locale)) return RETRY_COPY['zh-Hant-x-lzh'];
  if (/^zh-hans-x-lzh$/.test(locale)) return RETRY_COPY['zh-Hans-x-lzh'];
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(locale)) return RETRY_COPY['zh-TW'];
  if (locale === 'zh' || locale.startsWith('zh-')) return RETRY_COPY['zh-CN'];
  if (locale.split('-')[0] === 'pt') {
    const parts = locale.split('-');
    const region = parts[/^[a-z]{4}$/.test(parts[1] || '') ? 2 : 1];
    return RETRY_COPY[region === 'br' ? 'pt-BR' : 'pt-PT'];
  }
  return RETRY_COPY[locale.split('-')[0]] || RETRY_COPY.en;
};
