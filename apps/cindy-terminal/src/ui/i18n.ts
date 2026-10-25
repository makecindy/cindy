export type Locale = 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
const silentStopMessages: Record<Locale, string> = {
  en: 'The model repeatedly returned empty responses. Send a message to continue.',
  'zh-CN': '模型连续返回空响应，自动续跑已暂停。发送消息可继续任务。',
  'zh-TW': '模型連續傳回空回應，自動接續已暫停。傳送訊息可繼續任務。',
  ja: 'モデルが空の応答を繰り返したため、自動再開を停止しました。メッセージを送信すると続行できます。',
  ko: '모델이 반복해서 빈 응답을 반환하여 자동 재개를 중지했습니다. 메시지를 보내면 작업을 계속할 수 있습니다.',
};
export function silentStopMessage(locale: Locale) { return silentStopMessages[locale]; }
const runtimeRecoveryMessages: Record<Locale, string> = {
  "en": "Pi extensions could not be refreshed. Restart Cindy before using Pi again.",
  "zh-CN": "Pi 扩展未能完成刷新。请重启 Cindy 后再使用 Pi。",
  "zh-TW": "Pi 擴充功能未能完成重新整理。請重新啟動 Cindy 後再使用 Pi。",
  "ja": "Pi 拡張機能を更新できませんでした。Pi を再び使用する前に Cindy を再起動してください。",
  "ko": "Pi 확장을 새로 고치지 못했습니다. Pi를 다시 사용하기 전에 Cindy를 다시 시작하세요."
};
export function runtimeRecoveryMessage(locale: Locale) { return runtimeRecoveryMessages[locale]; }
const en = {
  emptyResources:'Nothing here yet',
  protocol:'API protocol',engines:'Model engines',install:'Install',update:'Update',repair:'Repair',notInstalled:'Not installed',providerLogin:'Sign in to provider',you: 'You', tasks: 'Sessions', models: 'Models', connections: 'Connections', service: 'Service',
  local: 'This computer', emptyTasks: 'No sessions yet', newTask: 'New session', send: 'Send',
  back: 'Back', cancel: 'Cancel', save: 'Save', next: 'Next', quit: 'Detach',
  loading: 'Loading…', working: 'Working…', ready: 'Ready', offline: 'Disconnected',
  reconnect: 'Reconnect', refresh: 'Refresh', error: 'The operation could not be completed',
  noModel: 'Connect a model to start', addProvider: 'Add connection', providerName: 'Connection name',
  address: 'API address', apiKey: 'API key', modelId: 'Model ID', engine: 'Engine',
  defaultModel: 'Default model', choose: 'Select', test: 'Test connection', connected: 'Connected',
  login: 'Sign in to Cindy', sso: 'Enterprise SSO', email: 'Email', organization: 'Organization',
  code: 'Verification code', openBrowser: 'Open this link on your computer or phone',
  waitBrowser: 'Waiting for authorization…', signedOut: 'Not signed in', accounts: 'Accounts',
  signOut: 'Sign out', confirmRegion: 'Continue to the organization’s region?', yes: 'Continue', no: 'Cancel',
  bindEmail: 'Link your email', bindPhone: 'Link your phone', resend: 'Resend code',
  vaultSetup: 'Protect your credentials', machineKey: 'Unlock automatically on this computer',
  passphraseKey: 'Unlock with a passphrase after restart', passphrase: 'Passphrase (12+ characters)',
  unlock: 'Unlock', locked: 'Credentials locked', initialized: 'Configured',
  vaultExplanation: 'Automatic unlock uses a key protected by this system account.',
  remoteEnabled: 'Allow remote control', startAtBoot: 'Start at boot', installService: 'Install service', uninstallService: 'Remove startup registration', startsAtLogin: 'Starts at next login', startsAtBoot: 'Starts at next boot', deviceName: 'Computer name', language: 'Language',
  stopService: 'Stop background service', uptime: 'Uptime', version: 'Version',
  noDevices: 'No connected computers', device: 'Computer', connect: 'Connect',
  search: 'Search', commands: 'Commands', message: 'Message', history: 'History',
  stop: 'Stop', requests: 'Pending requests', approve: 'Allow', deny: 'Deny',
  noRequests: 'No pending requests', directory: 'Working directory', resources: 'Resources',
  selected: 'Selected', detail: 'Details', done: 'Done', required: 'This field is required',
  keyboard: 'Tab: section   ↑↓: select   Enter: open   Esc: back   Ctrl+Q: detach',
  inputKeys: 'Enter: send   Alt+Enter: new line   Esc: cancel',
  continueLocal: 'Use your own model', connectionLost: 'Connection lost. Reconnect to check the result.',
  refreshLogin: 'Sign in again', notImplemented: 'This capability is not available on this host.',
};
type Messages = typeof en;
const zhCN: Messages = {
  emptyResources:'暂无内容',
  protocol:'API 协议',engines:'模型引擎',install:'安装',update:'更新',repair:'修复',notInstalled:'未安装',providerLogin:'登录模型账号',you:'你',tasks:'任务',models:'模型',connections:'连接',service:'服务',local:'这台电脑',emptyTasks:'还没有任务',newTask:'新建任务',send:'发送',
  back:'返回',cancel:'取消',save:'保存',next:'下一步',quit:'退出界面',loading:'正在加载…',working:'正在处理…',ready:'就绪',offline:'已断开',
  reconnect:'重新连接',refresh:'刷新',error:'操作未完成',noModel:'连接模型后即可开始',addProvider:'添加连接',providerName:'连接名称',address:'API 地址',
  apiKey:'API 密钥',modelId:'模型 ID',engine:'引擎',defaultModel:'默认模型',choose:'选择',test:'测试连接',connected:'已连接',
  login:'登录 Cindy',sso:'企业 SSO',email:'邮箱',organization:'组织',code:'验证码',openBrowser:'在电脑或手机上打开此链接',waitBrowser:'等待授权…',
  signedOut:'未登录',accounts:'账号',signOut:'退出登录',confirmRegion:'前往组织所属区域继续登录？',yes:'继续',no:'取消',bindEmail:'绑定邮箱',bindPhone:'绑定手机',resend:'重新发送验证码',
  vaultSetup:'保护登录凭据',machineKey:'在这台电脑上自动解锁',passphraseKey:'重启后使用口令解锁',passphrase:'解锁口令（至少 12 个字符）',unlock:'解锁',locked:'凭据已锁定',initialized:'已配置',
  vaultExplanation:'自动解锁使用受当前系统账号保护的密钥。',remoteEnabled:'允许远程控制',startAtBoot:'开机启动',installService:'安装常驻服务',uninstallService:'移除启动项',startsAtLogin:'下次登录时启动',startsAtBoot:'下次开机时启动',deviceName:'电脑名称',language:'语言',stopService:'停止后台服务',uptime:'已运行',version:'版本',
  noDevices:'没有已连接的电脑',device:'电脑',connect:'连接',search:'搜索',commands:'命令',message:'消息',history:'对话记录',stop:'停止',requests:'待处理',approve:'允许',deny:'拒绝',
  noRequests:'没有待处理请求',directory:'工作目录',resources:'资源',selected:'已选择',detail:'详情',done:'完成',required:'请填写此项',
  keyboard:'Tab 切换页面   ↑↓ 选择   Enter 打开   Esc 返回   Ctrl+Q 退出界面',inputKeys:'Enter 发送   Alt+Enter 换行   Esc 取消',
  continueLocal:'使用自己的模型',connectionLost:'连接已断开，重新连接后查看执行结果。',refreshLogin:'重新登录',notImplemented:'这台电脑尚不具备此能力。',
};
const zhTW: Messages = {
  emptyResources:'尚無內容',
  protocol:'API 協定',engines:'模型引擎',install:'安裝',update:'更新',repair:'修復',notInstalled:'未安裝',providerLogin:'登入模型帳號',you:'你',tasks:'任務',models:'模型',connections:'連線',service:'服務',local:'這部電腦',emptyTasks:'還沒有任務',newTask:'新增任務',send:'傳送',
  back:'返回',cancel:'取消',save:'儲存',next:'下一步',quit:'退出介面',loading:'正在載入…',working:'正在處理…',ready:'就緒',offline:'已中斷',
  reconnect:'重新連線',refresh:'重新整理',error:'操作未完成',noModel:'連接模型後即可開始',addProvider:'新增連線',providerName:'連線名稱',address:'API 位址',
  apiKey:'API 金鑰',modelId:'模型 ID',engine:'引擎',defaultModel:'預設模型',choose:'選擇',test:'測試連線',connected:'已連線',
  login:'登入 Cindy',sso:'企業 SSO',email:'電子郵件',organization:'組織',code:'驗證碼',openBrowser:'在電腦或手機上開啟此連結',waitBrowser:'等待授權…',
  signedOut:'未登入',accounts:'帳號',signOut:'登出',confirmRegion:'前往組織所屬區域繼續登入？',yes:'繼續',no:'取消',bindEmail:'綁定電子郵件',bindPhone:'綁定手機',resend:'重新傳送驗證碼',
  vaultSetup:'保護登入憑證',machineKey:'在這部電腦上自動解鎖',passphraseKey:'重新啟動後使用密語解鎖',passphrase:'解鎖密語（至少 12 個字元）',unlock:'解鎖',locked:'憑證已鎖定',initialized:'已設定',
  vaultExplanation:'自動解鎖使用受目前系統帳號保護的金鑰。',remoteEnabled:'允許遠端控制',startAtBoot:'開機啟動',installService:'安裝常駐服務',uninstallService:'移除啟動項目',startsAtLogin:'下次登入時啟動',startsAtBoot:'下次開機時啟動',deviceName:'電腦名稱',language:'語言',stopService:'停止背景服務',uptime:'已執行',version:'版本',
  noDevices:'沒有已連線的電腦',device:'電腦',connect:'連線',search:'搜尋',commands:'命令',message:'訊息',history:'對話記錄',stop:'停止',requests:'待處理',approve:'允許',deny:'拒絕',
  noRequests:'沒有待處理請求',directory:'工作目錄',resources:'資源',selected:'已選擇',detail:'詳細資訊',done:'完成',required:'請填寫此項',
  keyboard:'Tab 切換頁面   ↑↓ 選擇   Enter 開啟   Esc 返回   Ctrl+Q 退出介面',inputKeys:'Enter 傳送   Alt+Enter 換行   Esc 取消',
  continueLocal:'使用自己的模型',connectionLost:'連線已中斷，重新連線後查看執行結果。',refreshLogin:'重新登入',notImplemented:'這部電腦尚不具備此能力。',
};
const ja: Messages = {
  emptyResources:'まだ項目がありません',
  protocol:'API プロトコル',engines:'モデルエンジン',install:'インストール',update:'更新',repair:'修復',notInstalled:'未インストール',providerLogin:'プロバイダーにログイン',you:'あなた',tasks:'セッション',models:'モデル',connections:'接続',service:'サービス',local:'このコンピューター',emptyTasks:'セッションはありません',newTask:'新規セッション',send:'送信',
  back:'戻る',cancel:'キャンセル',save:'保存',next:'次へ',quit:'画面を閉じる',loading:'読み込み中…',working:'処理中…',ready:'準備完了',offline:'切断済み',
  reconnect:'再接続',refresh:'更新',error:'操作を完了できませんでした',noModel:'モデルを接続すると開始できます',addProvider:'接続を追加',providerName:'接続名',address:'API アドレス',
  apiKey:'API キー',modelId:'モデル ID',engine:'エンジン',defaultModel:'既定のモデル',choose:'選択',test:'接続をテスト',connected:'接続済み',
  login:'Cindy にログイン',sso:'企業 SSO',email:'メールアドレス',organization:'組織',code:'認証コード',openBrowser:'コンピューターまたはスマートフォンでリンクを開いてください',waitBrowser:'認証を待っています…',
  signedOut:'未ログイン',accounts:'アカウント',signOut:'ログアウト',confirmRegion:'組織のリージョンでログインを続けますか？',yes:'続ける',no:'キャンセル',bindEmail:'メールアドレスを連携',bindPhone:'電話番号を連携',resend:'コードを再送信',
  vaultSetup:'認証情報を保護',machineKey:'このコンピューターで自動解除',passphraseKey:'再起動後にパスフレーズで解除',passphrase:'パスフレーズ（12 文字以上）',unlock:'ロック解除',locked:'認証情報はロックされています',initialized:'設定済み',
  vaultExplanation:'自動解除には、このシステムアカウントで保護されたキーを使用します。',remoteEnabled:'リモート操作を許可',startAtBoot:'起動時に実行',installService:'常駐サービスをインストール',uninstallService:'自動起動を解除',startsAtLogin:'次回ログイン時に起動',startsAtBoot:'次回のシステム起動時に開始',deviceName:'コンピューター名',language:'言語',stopService:'バックグラウンドサービスを停止',uptime:'稼働時間',version:'バージョン',
  noDevices:'接続済みコンピューターはありません',device:'コンピューター',connect:'接続',search:'検索',commands:'コマンド',message:'メッセージ',history:'チャット履歴',stop:'停止',requests:'確認待ち',approve:'許可',deny:'拒否',
  noRequests:'確認待ちのリクエストはありません',directory:'作業ディレクトリ',resources:'リソース',selected:'選択済み',detail:'詳細',done:'完了',required:'入力してください',
  keyboard:'Tab: 画面切替   ↑↓: 選択   Enter: 開く   Esc: 戻る   Ctrl+Q: 閉じる',inputKeys:'Enter: 送信   Alt+Enter: 改行   Esc: キャンセル',
  continueLocal:'自分のモデルを使用',connectionLost:'接続が切れました。再接続して結果を確認してください。',refreshLogin:'再ログイン',notImplemented:'このホストでは利用できません。',
};
const ko: Messages = {
  emptyResources:'아직 항목이 없습니다',
  protocol:'API 프로토콜',engines:'모델 엔진',install:'설치',update:'업데이트',repair:'복구',notInstalled:'설치되지 않음',providerLogin:'공급자 로그인',you:'나',tasks:'세션',models:'모델',connections:'연결',service:'서비스',local:'이 컴퓨터',emptyTasks:'세션이 없습니다',newTask:'새 세션',send:'보내기',
  back:'뒤로',cancel:'취소',save:'저장',next:'다음',quit:'화면 닫기',loading:'불러오는 중…',working:'처리 중…',ready:'준비됨',offline:'연결 끊김',
  reconnect:'다시 연결',refresh:'새로 고침',error:'작업을 완료하지 못했습니다',noModel:'모델을 연결하면 시작할 수 있습니다',addProvider:'연결 추가',providerName:'연결 이름',address:'API 주소',
  apiKey:'API 키',modelId:'모델 ID',engine:'엔진',defaultModel:'기본 모델',choose:'선택',test:'연결 테스트',connected:'연결됨',
  login:'Cindy 로그인',sso:'기업 SSO',email:'이메일',organization:'조직',code:'인증 코드',openBrowser:'컴퓨터나 휴대폰에서 이 링크를 여세요',waitBrowser:'인증 대기 중…',
  signedOut:'로그인하지 않음',accounts:'계정',signOut:'로그아웃',confirmRegion:'조직의 리전에서 로그인을 계속할까요?',yes:'계속',no:'취소',bindEmail:'이메일 연결',bindPhone:'전화번호 연결',resend:'코드 다시 보내기',
  vaultSetup:'인증 정보 보호',machineKey:'이 컴퓨터에서 자동 잠금 해제',passphraseKey:'다시 시작한 후 암호로 잠금 해제',passphrase:'암호 (12자 이상)',unlock:'잠금 해제',locked:'인증 정보 잠김',initialized:'설정됨',
  vaultExplanation:'자동 잠금 해제는 현재 시스템 계정으로 보호되는 키를 사용합니다.',remoteEnabled:'원격 제어 허용',startAtBoot:'부팅 시 시작',installService:'상주 서비스 설치',uninstallService:'자동 시작 해제',startsAtLogin:'다음 로그인 시 시작',startsAtBoot:'다음 부팅 시 시작',deviceName:'컴퓨터 이름',language:'언어',stopService:'백그라운드 서비스 중지',uptime:'가동 시간',version:'버전',
  noDevices:'연결된 컴퓨터가 없습니다',device:'컴퓨터',connect:'연결',search:'검색',commands:'명령',message:'메시지',history:'채팅 기록',stop:'중지',requests:'대기 중인 요청',approve:'허용',deny:'거부',
  noRequests:'대기 중인 요청이 없습니다',directory:'작업 디렉터리',resources:'리소스',selected:'선택됨',detail:'상세 정보',done:'완료',required:'이 항목을 입력하세요',
  keyboard:'Tab: 화면 전환   ↑↓: 선택   Enter: 열기   Esc: 뒤로   Ctrl+Q: 닫기',inputKeys:'Enter: 보내기   Alt+Enter: 줄 바꿈   Esc: 취소',
  continueLocal:'내 모델 사용',connectionLost:'연결이 끊겼습니다. 다시 연결하여 결과를 확인하세요.',refreshLogin:'다시 로그인',notImplemented:'이 호스트에서는 사용할 수 없습니다.',
};
const messages: Record<Locale, Messages> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
export function getMessages(locale: Locale): Messages { return messages[locale]; }
export function resolveLocale(input = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en'): Locale {
  if (/^zh[_-](TW|HK|Hant)/i.test(input)) return 'zh-TW';
  if (/^zh/i.test(input)) return 'zh-CN';
  if (/^ja/i.test(input)) return 'ja';
  if (/^ko/i.test(input)) return 'ko';
  return 'en';
}

const controls = {
  en:{pluginWriteRecovery:"Confirm plugin write permission again",attachment:'Attachment',effort:'Reasoning effort',permission:'Permissions',plan:'Plan mode',fast:'Fast mode',contextRebuilt:'Context rebuilt',compact:'Compact context',clear:'Clear context',attach:'Add attachment',on:'On',off:'Off',removeAttachments:'Remove attachments',filePath:'Local file path'},
  'zh-CN':{pluginWriteRecovery:"重新确认插件写权限",attachment:'附件',effort:'思考强度',permission:'权限',plan:'计划模式',fast:'快速模式',contextRebuilt:'已整理上下文',compact:'压缩上下文',clear:'清空上下文',attach:'添加附件',on:'开启',off:'关闭',removeAttachments:'移除附件',filePath:'本地文件路径'},
  'zh-TW':{pluginWriteRecovery:"重新確認插件寫入權限",attachment:'附件',effort:'思考強度',permission:'權限',plan:'計畫模式',fast:'快速模式',contextRebuilt:'已整理上下文',compact:'壓縮上下文',clear:'清空上下文',attach:'新增附件',on:'開啟',off:'關閉',removeAttachments:'移除附件',filePath:'本機檔案路徑'},
  ja:{pluginWriteRecovery:"プラグインの書き込み権限を再確認",attachment:'添付ファイル',effort:'推論の強度',permission:'権限',plan:'計画モード',fast:'高速モード',contextRebuilt:'コンテキストを再構築しました',compact:'コンテキストを圧縮',clear:'コンテキストをクリア',attach:'添付ファイルを追加',on:'オン',off:'オフ',removeAttachments:'添付ファイルを削除',filePath:'ローカルファイルのパス'},
  ko:{pluginWriteRecovery:"플러그인 쓰기 권한 다시 확인",attachment:'첨부 파일',effort:'추론 강도',permission:'권한',plan:'계획 모드',fast:'빠른 모드',contextRebuilt:'컨텍스트를 다시 구성했습니다',compact:'컨텍스트 압축',clear:'컨텍스트 지우기',attach:'첨부 파일 추가',on:'켜기',off:'끄기',removeAttachments:'첨부 파일 제거',filePath:'로컬 파일 경로'},
};
export function getControlMessages(locale:Locale){return controls[locale];}

const shellMessages={
  en:{connected:'Terminal',detach:'Ctrl+] detaches; the shell keeps running.',gap:'Earlier terminal output is no longer in the buffer.'},
  'zh-CN':{connected:'终端',detach:'Ctrl+] 退出连接，Shell 继续运行。',gap:'更早的终端输出已超出缓冲区。'},
  'zh-TW':{connected:'終端',detach:'Ctrl+] 退出連線，Shell 繼續執行。',gap:'更早的終端輸出已超出緩衝區。'},
  ja:{connected:'ターミナル',detach:'Ctrl+] で切断します。シェルは実行を続けます。',gap:'以前のターミナル出力はバッファーに残っていません。'},
  ko:{connected:'터미널',detach:'Ctrl+]로 연결을 종료합니다. 셸은 계속 실행됩니다.',gap:'이전 터미널 출력이 버퍼 범위를 벗어났습니다.'},
};
export function getShellMessages(locale:Locale){return shellMessages[locale];}

const modelMessages={
  en:{manage:'Manage connections',edit:'Edit connection',custom:'Custom API',source:'Connection source',discover:'Get model list',test:'Generation test (may incur a charge)',testPassed:'Generation test passed',disable:'Disable',enable:'Enable',reset:'Restore defaults',disconnect:'Disconnect account',remove:'Remove connection',keepKey:'New API key (leave blank to keep)',addModel:'Add model',configure:'Configure model',contextLimit:'Context limit',context:'Context window (tokens)',modelName:'Model name',headers:'Replace request headers (JSON, leave blank to keep)',auth:'Authentication',none:'No authentication',apiKey:'API key',testResult:'Test result'},
  'zh-CN':{manage:'管理连接',edit:'编辑连接',custom:'自定义 API',source:'连接来源',discover:'获取模型列表',test:'生成测试（可能产生费用）',testPassed:'生成测试通过',disable:'停用',enable:'启用',reset:'恢复默认',disconnect:'断开账号',remove:'移除连接',keepKey:'新 API 密钥（留空保留）',addModel:'添加模型',configure:'配置模型',contextLimit:'上下文上限',context:'上下文窗口（Token）',modelName:'模型名称',headers:'替换请求头（JSON，留空保留）',auth:'认证方式',none:'无需认证',apiKey:'API 密钥',testResult:'测试结果'},
  'zh-TW':{manage:'管理連線',edit:'編輯連線',custom:'自訂 API',source:'連線來源',discover:'取得模型清單',test:'生成測試（可能產生費用）',testPassed:'生成測試通過',disable:'停用',enable:'啟用',reset:'恢復預設',disconnect:'中斷帳號',remove:'移除連線',keepKey:'新 API 金鑰（留空保留）',addModel:'新增模型',configure:'設定模型',contextLimit:'上下文上限',context:'上下文視窗（Token）',modelName:'模型名稱',headers:'替換請求標頭（JSON，留空保留）',auth:'認證方式',none:'無需認證',apiKey:'API 金鑰',testResult:'測試結果'},
  ja:{manage:'接続を管理',edit:'接続を編集',custom:'カスタム API',source:'接続元',discover:'モデル一覧を取得',test:'生成テスト（料金が発生する場合があります）',testPassed:'生成テストに成功しました',disable:'無効にする',enable:'有効にする',reset:'既定に戻す',disconnect:'アカウントを切断',remove:'接続を削除',keepKey:'新しい API キー（空欄で保持）',addModel:'モデルを追加',configure:'モデルを設定',contextLimit:'コンテキスト上限',context:'コンテキストウィンドウ（トークン）',modelName:'モデル名',headers:'リクエストヘッダーを置換（JSON、空欄で保持）',auth:'認証方法',none:'認証なし',apiKey:'API キー',testResult:'テスト結果'},
  ko:{manage:'연결 관리',edit:'연결 편집',custom:'사용자 지정 API',source:'연결 소스',discover:'모델 목록 가져오기',test:'생성 테스트 (요금이 발생할 수 있음)',testPassed:'생성 테스트 성공',disable:'비활성화',enable:'활성화',reset:'기본값 복원',disconnect:'계정 연결 해제',remove:'연결 삭제',keepKey:'새 API 키 (비워 두면 유지)',addModel:'모델 추가',configure:'모델 설정',contextLimit:'컨텍스트 한도',context:'컨텍스트 창 (토큰)',modelName:'모델 이름',headers:'요청 헤더 교체 (JSON, 비워 두면 유지)',auth:'인증 방식',none:'인증 없음',apiKey:'API 키',testResult:'테스트 결과'},
};
export function getModelMessages(locale:Locale){return modelMessages[locale];}

const serviceMessages:Record<Locale,{activate:string;running:string;boot:string}>={
 en:{activate:'Start managed service now',running:'Running under system service manager',boot:'Start at boot (OS authorization required)'},
 'zh-CN':{activate:'立即启用常驻服务',running:'正由系统服务管理器运行',boot:'开机启动（需要系统授权）'},
 'zh-TW':{activate:'立即啟用常駐服務',running:'正由系統服務管理員執行',boot:'開機啟動（需要系統授權）'},
 ja:{activate:'常駐サービスを今すぐ開始',running:'システムサービスとして実行中',boot:'起動時に開始（システム認証が必要）'},
 ko:{activate:'상주 서비스 지금 시작',running:'시스템 서비스로 실행 중',boot:'부팅 시 시작 (시스템 인증 필요)'},
};
export function getServiceMessages(locale:Locale){return serviceMessages[locale];}

const channelPermissionMessages: Record<Locale, string> = {
  "en": "The current Agent cannot run on this channel in this permission mode, so messages cannot be processed. Send /permission to choose a supported mode.",
  "zh-CN": "当前 Agent 不支持以此权限模式在该渠道运行，消息将无法处理。请发送 /permission 调整权限模式。",
  "zh-TW": "目前 Agent 不支援以此權限模式在該渠道執行，訊息將無法處理。請傳送 /permission 調整權限模式。",
  "ja": "現在の Agent はこの権限モードではこのチャンネルを利用できないため、メッセージを処理できません。/permission を送信して対応する権限モードに変更してください。",
  "ko": "현재 Agent는 이 권한 모드로 이 채널에서 실행할 수 없어 메시지를 처리할 수 없습니다. /permission을 보내 지원되는 권한 모드로 변경하세요."
};
export function channelPermissionUnavailable(locale: Locale) { return channelPermissionMessages[locale]; }

const telegramCommandMenus: Record<Locale, Record<string, string>> = {
  "en": {
    "start": "Welcome and usage",
    "new": "Create a new session",
    "help": "Show command help",
    "stop": "Stop the current task",
    "session": "Recent sessions, pick one to continue",
    "project": "Switch project workspace",
    "model": "Show or switch the model",
    "permission": "Show or switch the permission mode",
    "settings": "Show project and agent settings",
    "ctr": "Remotely control a desktop session",
    "exctr": "Exit remote control",
    "workspace": "Switch project workspace",
    "unbind": "Clear the current project mapping",
    "effort": "Choose reasoning effort",
    "agent": "Choose an Agent",
    "status": "Show link status",
    "unlink": "Unlink Telegram"
  },
  "zh-CN": {
    "start": "查看欢迎信息和用法",
    "new": "创建新任务",
    "help": "查看命令帮助",
    "stop": "中止当前执行",
    "session": "最近任务列表，选中即续聊",
    "project": "切换项目工作区",
    "model": "查看或切换模型",
    "permission": "查看或切换权限模式",
    "settings": "查看当前项目与 Agent 设置",
    "ctr": "接管桌面端的任务",
    "exctr": "退出远程控制",
    "workspace": "切换项目工作区",
    "unbind": "清除当前项目映射",
    "effort": "选择推理强度",
    "agent": "选择 Agent",
    "status": "查看关联状态",
    "unlink": "解除 Telegram 关联"
  },
  "zh-TW": {
    "start": "檢視歡迎資訊和用法",
    "new": "建立新任務",
    "help": "檢視命令幫助",
    "stop": "中止當前執行",
    "session": "最近任務列表，選中即續聊",
    "project": "切換專案工作區",
    "model": "檢視或切換模型",
    "permission": "檢視或切換權限模式",
    "settings": "檢視目前專案與 Agent 設定",
    "ctr": "接管桌面端的任務",
    "exctr": "退出遠端控制",
    "workspace": "切換專案工作區",
    "unbind": "清除目前專案對應",
    "effort": "選擇推理強度",
    "agent": "選擇 Agent",
    "status": "檢視關聯狀態",
    "unlink": "解除 Telegram 關聯"
  },
  "ja": {
    "start": "ようこそと使い方を表示",
    "new": "新しいセッションを作成",
    "help": "コマンドヘルプを表示",
    "stop": "現在のタスクを停止",
    "session": "最近のセッション一覧から続行",
    "project": "プロジェクトワークスペースを切り替え",
    "model": "モデルを表示・切り替え",
    "permission": "権限モードを表示・切り替え",
    "settings": "プロジェクトと Agent 設定を表示",
    "ctr": "デスクトップセッションをリモート操作",
    "exctr": "リモート操作を終了",
    "workspace": "プロジェクトワークスペースを切り替え",
    "unbind": "現在のプロジェクト設定を解除",
    "effort": "推論強度を選択",
    "agent": "Agent を選択",
    "status": "連携状態を表示",
    "unlink": "Telegram 連携を解除"
  },
  "ko": {
    "start": "환영 메시지와 사용법 보기",
    "new": "새 세션 만들기",
    "help": "명령어 도움말 보기",
    "stop": "현재 작업 중지",
    "session": "최근 세션 목록에서 이어서 대화",
    "project": "프로젝트 워크스페이스 전환",
    "model": "모델 보기·전환",
    "permission": "권한 모드 보기·전환",
    "settings": "프로젝트와 Agent 설정 보기",
    "ctr": "데스크톱 세션 원격 제어",
    "exctr": "원격 제어 종료",
    "workspace": "프로젝트 워크스페이스 전환",
    "unbind": "현재 프로젝트 매핑 해제",
    "effort": "추론 강도 선택",
    "agent": "Agent 선택",
    "status": "연결 상태 보기",
    "unlink": "Telegram 연결 해제"
  }
};
export function telegramCommandDescription(locale: Locale, key: string) {
  const command = key.replace(/^settings\.telegramBot\.commandMenu\./, "");
  return telegramCommandMenus[locale][command] ?? telegramCommandMenus.en[command] ?? command;
}
