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
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(locale)) return RETRY_COPY['zh-TW'];
  if (locale === 'zh' || locale.startsWith('zh-')) return RETRY_COPY['zh-CN'];
  return RETRY_COPY[locale.split('-')[0]] || RETRY_COPY.en;
};
