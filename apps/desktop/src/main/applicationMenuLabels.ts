/**
 * macOS 原生应用菜单的四语标签。
 *
 * 单独成模块是为了**能被术语门禁扫到**。它和 i18next 的 locale JSON 一样是用户可见
 * 文案,但不走 i18next,check-i18n-glossary.mjs 只读 locale JSON 扫不到它——引入术语表
 * 时这里就漏掉了「议题」(Issue 的禁用译法)和三处 ASCII 省略号,而这是 macOS 上一直
 * 挂在屏幕顶端的菜单栏。
 *
 * 覆盖它的是 __tests__/applicationMenuLabels.test.ts,与 mobile 影子 catalog 同一套路子:
 * vitest 直接 import 运行时对象,复用 scripts/shared/glossary-rules.mjs 的判定。
 * 之所以要抽出来,是因为原先它嵌在 bootstrap-electron.ts 里,测试一 import 就会拉起
 * 整个 Electron 主进程模块。
 *
 * `installCli*` 一组里的 `{{cmd}}` 是**命令名占位符**,由调用侧按本构建 edition 品牌
 * 替换(global/cn → `cindy`,dev → `cindydev`,见 installCliCommand.ts 的
 * CLI_COMMAND_NAME);`{{path}}` 替换为 symlink 安装路径。文案里的 “Cindy” 指产品/应用
 * 本身,不随命令名变化,故保留。
 */
import type { SupportedLocale } from '../shared/locale.js';

export type ApplicationMenuLocale = SupportedLocale;

export interface ApplicationMenuLabels {
  about: string;
  hide: string;
  quit: string;
  settings: string;
  checkForUpdates: string;
  fileMenu: string;
  newMaker: string;
  viewMenu: string;
  toggleSidebar: string;
  windowMenu: string;
  helpMenu: string;
  performanceTrace: string;
  help: string;
  releaseNotes: string;
  issues: string;
  installCli: string;
  installCliConfirmTitle: string;
  installCliConfirmDetail: string;
  installCliConfirmOk: string;
  installCliCancel: string;
  installCliSuccessTitle: string;
  installCliSuccessDetail: string;
  installCliErrorTitle: string;
  installCliErrorDetail: string;
  installCliDevOnlyTitle: string;
  installCliDevOnlyDetail: string;
  installCliUnsupportedTitle: string;
  installCliUnsupportedDetail: string;
  installCliNotInApplicationsTitle: string;
  installCliNotInApplicationsDetail: string;
  installCliMoveToApplications: string;
}

export const APPLICATION_MENU_LABELS: Record<ApplicationMenuLocale, ApplicationMenuLabels> = {
  'zh-CN': {
    about: '关于 {{appName}}',
    hide: '隐藏 {{appName}}',
    quit: '退出 {{appName}}',
    settings: '设置…',
    checkForUpdates: '检查更新…',
    fileMenu: '文件',
    newMaker: '新建任务',
    viewMenu: '显示',
    toggleSidebar: '切换侧边栏',
    windowMenu: '窗口',
    helpMenu: '帮助',
    performanceTrace: '性能跟踪…',
    help: '帮助',
    releaseNotes: '最新更新介绍',
    issues: '问题反馈',
    installCli: '安装到命令行',
    installCliConfirmTitle: '把 {{cmd}} 命令安装到命令行？',
    installCliConfirmDetail:
      '将在 {{path}} 创建指向 Cindy 的符号链接；若该路径已存在同名文件，会被替换。之后在终端运行 {{cmd}} . 即可把当前目录作为工作目录在 Cindy 中打开。系统会请求你的管理员密码以写入该目录。',
    installCliConfirmOk: '安装',
    installCliCancel: '取消',
    installCliSuccessTitle: '{{cmd}} 命令已安装',
    installCliSuccessDetail:
      '已安装到 {{path}}。重开一个终端窗口后运行 {{cmd}} . 即可。若提示找不到命令，请确认该目录在你的 PATH 中。',
    installCliErrorTitle: '安装失败',
    installCliErrorDetail: '未能安装 {{cmd}} 命令。',
    installCliDevOnlyTitle: '仅正式版可用',
    installCliDevOnlyDetail:
      '开发模式下无法安装命令行工具：此时的可执行文件指向 Electron 解释器，而非 Cindy 应用。请在正式安装的 Cindy 中使用此功能。',
    installCliUnsupportedTitle: '暂不支持当前系统',
    installCliUnsupportedDetail: '安装到命令行目前仅支持 macOS。',
    installCliNotInApplicationsTitle: '请先把 Cindy 移动到「应用程序」文件夹',
    installCliNotInApplicationsDetail:
      '当前 Cindy 运行在临时位置（不在「应用程序」文件夹里）。此时安装的命令会指向这个临时路径，应用退出或磁盘弹出后即失效。请先把 Cindy 移动到「应用程序」文件夹，再安装命令行。',
    installCliMoveToApplications: '移动到「应用程序」',
  },
  'zh-TW': {
    about: '關於 {{appName}}',
    hide: '隱藏 {{appName}}',
    quit: '結束 {{appName}}',
    settings: '設定…',
    checkForUpdates: '檢查更新…',
    fileMenu: '檔案',
    newMaker: '新增任務',
    viewMenu: '顯示方式',
    toggleSidebar: '切換側邊欄',
    windowMenu: '視窗',
    helpMenu: '輔助說明',
    performanceTrace: '效能追蹤…',
    help: '輔助說明',
    releaseNotes: '最新更新',
    issues: '問題回報',
    installCli: '安裝命令列工具',
    installCliConfirmTitle: '要將 {{cmd}} 命令安裝到命令列嗎？',
    installCliConfirmDetail:
      '系統會在 {{path}} 建立指向 Cindy 的符號連結；如果該路徑已有同名檔案，將會取代它。之後在終端機執行 {{cmd}} .，即可將目前目錄作為工作目錄在 Cindy 中開啟。系統會要求你輸入管理員密碼，以便寫入該位置。',
    installCliConfirmOk: '安裝',
    installCliCancel: '取消',
    installCliSuccessTitle: '{{cmd}} 命令已安裝',
    installCliSuccessDetail:
      '已安裝到 {{path}}。請開啟新的終端機視窗並執行 {{cmd}} .。如果找不到命令，請確認該目錄已加入 PATH。',
    installCliErrorTitle: '安裝失敗',
    installCliErrorDetail: '無法安裝 {{cmd}} 命令。',
    installCliDevOnlyTitle: '僅正式版本可用',
    installCliDevOnlyDetail:
      '開發模式無法安裝命令列工具：此時可執行檔指向 Electron 執行環境，而不是 Cindy 應用程式。請在已安裝的 Cindy 中使用此功能。',
    installCliUnsupportedTitle: '目前系統不支援',
    installCliUnsupportedDetail: '目前僅 macOS 支援安裝命令列工具。',
    installCliNotInApplicationsTitle: '請先將 Cindy 移到「應用程式」檔案夾',
    installCliNotInApplicationsDetail:
      'Cindy 目前從暫存位置（不在「應用程式」檔案夾）執行。在此狀態下安裝的命令會指向暫存路徑，應用程式結束或磁碟退出後就會失效。請先將 Cindy 移到「應用程式」檔案夾，再安裝命令列工具。',
    installCliMoveToApplications: '移到「應用程式」',
  },
  en: {
    about: 'About {{appName}}',
    hide: 'Hide {{appName}}',
    quit: 'Quit {{appName}}',
    settings: 'Settings…',
    checkForUpdates: 'Check for Updates…',
    fileMenu: 'File',
    newMaker: 'New Session',
    viewMenu: 'View',
    toggleSidebar: 'Toggle Sidebar',
    windowMenu: 'Window',
    helpMenu: 'Help',
    performanceTrace: 'Performance Trace…',
    help: 'Help',
    releaseNotes: "What's New",
    issues: 'Issues',
    installCli: "Install '{{cmd}}' Command in PATH",
    installCliConfirmTitle: "Install the '{{cmd}}' command in your PATH?",
    installCliConfirmDetail:
      'A symlink to Cindy will be created at {{path}}; if a file already exists there, it will be replaced. You can then run `{{cmd}} .` in a terminal to open the current directory as a working directory in Cindy. You will be asked for your administrator password to write to that location.',
    installCliConfirmOk: 'Install',
    installCliCancel: 'Cancel',
    installCliSuccessTitle: "'{{cmd}}' command installed",
    installCliSuccessDetail:
      'Installed at {{path}}. Open a new terminal window and run `{{cmd}} .`. If the command is not found, make sure that directory is on your PATH.',
    installCliErrorTitle: 'Installation failed',
    installCliErrorDetail: "Could not install the '{{cmd}}' command.",
    installCliDevOnlyTitle: 'Packaged build only',
    installCliDevOnlyDetail:
      'The command-line tool cannot be installed in development mode: the executable points at the Electron runtime rather than the Cindy app. Use this from an installed Cindy build.',
    installCliUnsupportedTitle: 'Not supported on this system',
    installCliUnsupportedDetail: "Installing the '{{cmd}}' command is currently supported on macOS only.",
    installCliNotInApplicationsTitle: 'Move Cindy to the Applications folder first',
    installCliNotInApplicationsDetail:
      'Cindy is running from a temporary location (not the Applications folder). A command installed now would point at that temporary path and break as soon as the app quits or the volume is ejected. Move Cindy to the Applications folder, then install the command.',
    installCliMoveToApplications: 'Move to Applications',
  },
  ja: {
    about: '{{appName}} について',
    hide: '{{appName}}を隠す',
    quit: '{{appName}}を終了',
    settings: '設定…',
    checkForUpdates: 'アップデートを確認…',
    fileMenu: 'ファイル',
    newMaker: '新規セッション',
    viewMenu: '表示',
    toggleSidebar: 'サイドバーを切り替え',
    windowMenu: 'ウインドウ',
    helpMenu: 'ヘルプ',
    performanceTrace: 'パフォーマンスの記録…',
    help: 'ヘルプ',
    releaseNotes: '最新情報',
    issues: 'フィードバック',
    installCli: 'コマンドラインに {{cmd}} をインストール',
    installCliConfirmTitle: '{{cmd}} コマンドをコマンドラインにインストールしますか?',
    installCliConfirmDetail:
      'Cindy へのシンボリックリンクを {{path}} に作成します。そのパスに既存のファイルがある場合は置き換えられます。その後ターミナルで {{cmd}} . を実行すると、現在のディレクトリを作業ディレクトリとして Cindy で開けます。この場所への書き込みには管理者パスワードの入力を求められます。',
    installCliConfirmOk: 'インストール',
    installCliCancel: 'キャンセル',
    installCliSuccessTitle: '{{cmd}} コマンドをインストールしました',
    installCliSuccessDetail:
      '{{path}} にインストールしました。新しいターミナルウインドウを開いて {{cmd}} . を実行してください。コマンドが見つからない場合は、そのディレクトリが PATH に含まれているか確認してください。',
    installCliErrorTitle: 'インストールに失敗しました',
    installCliErrorDetail: '{{cmd}} コマンドをインストールできませんでした。',
    installCliDevOnlyTitle: '正式ビルドのみ対応',
    installCliDevOnlyDetail:
      '開発モードではコマンドラインツールをインストールできません。実行ファイルが Cindy アプリではなく Electron ランタイムを指しているためです。インストール済みの Cindy から実行してください。',
    installCliUnsupportedTitle: 'このシステムには非対応',
    installCliUnsupportedDetail: 'コマンドラインへのインストールは現在 macOS のみ対応しています。',
    installCliNotInApplicationsTitle: 'まず Cindy を「アプリケーション」フォルダに移動してください',
    installCliNotInApplicationsDetail:
      'Cindy は一時的な場所(「アプリケーション」フォルダの外)で実行されています。この状態でインストールしたコマンドはその一時パスを指すため、アプリの終了やボリュームの取り出しで無効になります。Cindy を「アプリケーション」フォルダに移動してから、コマンドをインストールしてください。',
    installCliMoveToApplications: '「アプリケーション」に移動',
  },
  ko: {
    about: '{{appName}} 정보',
    hide: '{{appName}} 가리기',
    quit: '{{appName}} 종료',
    settings: '설정…',
    checkForUpdates: '업데이트 확인…',
    fileMenu: '파일',
    newMaker: '새 세션',
    viewMenu: '보기',
    toggleSidebar: '사이드바 토글',
    windowMenu: '윈도우',
    helpMenu: '도움말',
    performanceTrace: '성능 기록…',
    help: '도움말',
    releaseNotes: '최신 업데이트',
    issues: '이슈',
    installCli: '명령줄에 {{cmd}} 명령 설치',
    installCliConfirmTitle: '{{cmd}} 명령을 명령줄에 설치할까요?',
    installCliConfirmDetail:
      'Cindy를 가리키는 심볼릭 링크를 {{path}}에 만듭니다. 해당 경로에 파일이 이미 있으면 대체됩니다. 이후 터미널에서 {{cmd}} . 를 실행하면 현재 디렉터리를 작업 디렉터리로 Cindy에서 열 수 있습니다. 이 위치에 쓰려면 관리자 암호를 입력해야 합니다.',
    installCliConfirmOk: '설치',
    installCliCancel: '취소',
    installCliSuccessTitle: '{{cmd}} 명령을 설치했습니다',
    installCliSuccessDetail:
      '{{path}}에 설치했습니다. 새 터미널 창을 열고 {{cmd}} . 를 실행하세요. 명령을 찾을 수 없으면 해당 디렉터리가 PATH에 있는지 확인하세요.',
    installCliErrorTitle: '설치 실패',
    installCliErrorDetail: '{{cmd}} 명령을 설치하지 못했습니다.',
    installCliDevOnlyTitle: '정식 빌드에서만 사용 가능',
    installCliDevOnlyDetail:
      '개발 모드에서는 명령줄 도구를 설치할 수 없습니다. 실행 파일이 Cindy 앱이 아닌 Electron 런타임을 가리키기 때문입니다. 설치된 Cindy에서 사용하세요.',
    installCliUnsupportedTitle: '이 시스템에서는 지원되지 않음',
    installCliUnsupportedDetail: '명령줄 설치는 현재 macOS에서만 지원됩니다.',
    installCliNotInApplicationsTitle: '먼저 Cindy를 응용 프로그램 폴더로 옮기세요',
    installCliNotInApplicationsDetail:
      'Cindy가 임시 위치(응용 프로그램 폴더 밖)에서 실행되고 있습니다. 지금 설치하는 명령은 이 임시 경로를 가리키므로 앱을 종료하거나 볼륨을 꺼내면 작동하지 않습니다. Cindy를 응용 프로그램 폴더로 옮긴 다음 명령을 설치하세요.',
    installCliMoveToApplications: '응용 프로그램으로 이동',
  },

  "es": {
    "about": "Acerca de {{appName}}",
    "hide": "Ocultar {{appName}}",
    "quit": "Salir de {{appName}}",
    "settings": "Configuración…",
    "checkForUpdates": "Buscar actualizaciones…",
    "fileMenu": "Archivo",
    "newMaker": "Nueva sesión",
    "viewMenu": "Ver",
    "toggleSidebar": "Alternar barra lateral",
    "windowMenu": "Ventana",
    "helpMenu": "Ayuda",
    "performanceTrace": "Seguimiento de rendimiento…",
    "help": "Ayuda",
    "releaseNotes": "¿Qué hay de nuevo?",
    "issues": "Incidencias",
    "installCli": "Instalar comando '{{cmd}}' en PATH",
    "installCliConfirmTitle": "¿Instalar el comando '{{cmd}}' en tu PATH?",
    "installCliConfirmDetail": "Se creará un enlace simbólico a Cindy en {{path}}. Si ya existe un archivo allí, se reemplazará. Después, podrás ejecutar `{{cmd}} .` en una terminal para abrir el directorio actual como directorio de trabajo en Cindy. Se te pedirá la contraseña de administrador para escribir en esa ubicación.",
    "installCliConfirmOk": "Instalar",
    "installCliCancel": "Cancelar",
    "installCliSuccessTitle": "Comando '{{cmd}}' instalado",
    "installCliSuccessDetail": "Instalado en {{path}}. Abre una nueva ventana de terminal y ejecuta `{{cmd}} .`. Si no se encuentra el comando, comprueba que ese directorio esté en tu PATH.",
    "installCliErrorTitle": "La instalación falló",
    "installCliErrorDetail": "No se pudo instalar el comando '{{cmd}}'.",
    "installCliDevOnlyTitle": "Solo en la aplicación instalada",
    "installCliDevOnlyDetail": "La herramienta de línea de comandos no se puede instalar en modo de desarrollo: el ejecutable apunta al tiempo de ejecución Electron en lugar de a la aplicación Cindy. Usa esta opción desde una versión instalada de Cindy.",
    "installCliUnsupportedTitle": "No compatible con este sistema",
    "installCliUnsupportedDetail": "Actualmente, la instalación del comando '{{cmd}}' solo se admite en macOS.",
    "installCliNotInApplicationsTitle": "Primero mueve Cindy a la carpeta Aplicaciones",
    "installCliNotInApplicationsDetail": "Cindy se ejecuta desde una ubicación temporal (no la carpeta Aplicaciones). Un comando instalado ahora apuntaría a esa ruta temporal y se interrumpiría tan pronto como se cierre la aplicación o se expulse el volumen. Mueve Cindy a la carpeta Aplicaciones y luego instala el comando.",
    "installCliMoveToApplications": "Mover a Aplicaciones"
  },
  "fr": {
    "about": "À propos de {{appName}}",
    "hide": "Masquer {{appName}}",
    "quit": "Quitter {{appName}}",
    "settings": "Paramètres…",
    "checkForUpdates": "Rechercher des mises à jour…",
    "fileMenu": "Fichier",
    "newMaker": "Nouvelle session",
    "viewMenu": "Présentation",
    "toggleSidebar": "Afficher/masquer la barre latérale",
    "windowMenu": "Fenêtre",
    "helpMenu": "Aide",
    "performanceTrace": "Suivi des performances…",
    "help": "Aide",
    "releaseNotes": "Nouveautés",
    "issues": "Issues",
    "installCli": "Installer la commande '{{cmd}}' dans le PATH",
    "installCliConfirmTitle": "Installer la commande '{{cmd}}' dans votre PATH ?",
    "installCliConfirmDetail": "Un lien symbolique vers Cindy sera créé dans {{path}} ; si un fichier existe déjà à cet emplacement, il sera remplacé. Vous pourrez ensuite exécuter `{{cmd}} .` dans un terminal pour ouvrir le répertoire courant comme répertoire de travail dans Cindy. Votre mot de passe administrateur vous sera demandé pour écrire à cet emplacement.",
    "installCliConfirmOk": "Installer",
    "installCliCancel": "Annuler",
    "installCliSuccessTitle": "Commande '{{cmd}}' installée",
    "installCliSuccessDetail": "Installée dans {{path}}. Ouvrez une nouvelle fenêtre de terminal et exécutez `{{cmd}} .`. Si la commande est introuvable, vérifiez que ce répertoire figure dans votre PATH.",
    "installCliErrorTitle": "Échec de l'installation",
    "installCliErrorDetail": "Impossible d'installer la commande '{{cmd}}'.",
    "installCliDevOnlyTitle": "Version packagée uniquement",
    "installCliDevOnlyDetail": "L'outil en ligne de commande ne peut pas être installé en mode développement : l'exécutable pointe vers l'environnement Electron et non vers l'application Cindy. Utilisez cette option depuis une version installée de Cindy.",
    "installCliUnsupportedTitle": "Non pris en charge sur ce système",
    "installCliUnsupportedDetail": "L'installation de la commande '{{cmd}}' n'est actuellement prise en charge que sur macOS.",
    "installCliNotInApplicationsTitle": "Déplacez d'abord Cindy dans le dossier Applications",
    "installCliNotInApplicationsDetail": "Cindy s'exécute depuis un emplacement temporaire (pas le dossier Applications). Une commande installée maintenant pointerait vers ce chemin temporaire et cesserait de fonctionner dès que l'application sera quittée ou le volume éjecté. Déplacez Cindy dans le dossier Applications, puis installez la commande.",
    "installCliMoveToApplications": "Déplacer dans Applications"
  },
  "de": {
    "about": "Über {{appName}}",
    "hide": "{{appName}} ausblenden",
    "quit": "{{appName}} beenden",
    "settings": "Einstellungen…",
    "checkForUpdates": "Nach Updates suchen…",
    "fileMenu": "Datei",
    "newMaker": "Neue Sitzung",
    "viewMenu": "Ansicht",
    "toggleSidebar": "Seitenleiste umschalten",
    "windowMenu": "Fenster",
    "helpMenu": "Hilfe",
    "performanceTrace": "Leistungsaufzeichnung…",
    "help": "Hilfe",
    "releaseNotes": "Neuigkeiten",
    "issues": "Issues",
    "installCli": "Befehl „{{cmd}}“ in PATH installieren",
    "installCliConfirmTitle": "Befehl „{{cmd}}“ in deinem PATH installieren?",
    "installCliConfirmDetail": "Unter {{path}} wird ein symbolischer Link zu Cindy angelegt. Eine dort bereits vorhandene Datei wird ersetzt. Anschließend kannst du `{{cmd}} .` im Terminal ausführen, um das aktuelle Verzeichnis als Arbeitsverzeichnis in Cindy zu öffnen. Zum Schreiben an diesem Speicherort wirst du nach deinem Administratorpasswort gefragt.",
    "installCliConfirmOk": "Installieren",
    "installCliCancel": "Abbrechen",
    "installCliSuccessTitle": "Befehl „{{cmd}}“ installiert",
    "installCliSuccessDetail": "Unter {{path}} installiert. Öffne ein neues Terminalfenster und führe `{{cmd}} .` aus. Falls der Befehl nicht gefunden wird, prüfe, ob dieses Verzeichnis in deinem PATH enthalten ist.",
    "installCliErrorTitle": "Die Installation ist fehlgeschlagen",
    "installCliErrorDetail": "Der Befehl „{{cmd}}“ konnte nicht installiert werden.",
    "installCliDevOnlyTitle": "Nur in installierter Version verfügbar",
    "installCliDevOnlyDetail": "Das Befehlszeilenwerkzeug kann im Entwicklungsmodus nicht installiert werden, da die ausführbare Datei auf die Electron-Laufzeit verweist. Installiere es aus einer installierten Cindy-Version.",
    "installCliUnsupportedTitle": "Wird auf diesem System nicht unterstützt",
    "installCliUnsupportedDetail": "Die Installation des Befehls „{{cmd}}“ wird derzeit nur auf macOS unterstützt.",
    "installCliNotInApplicationsTitle": "Cindy zuerst in „Programme“ verschieben",
    "installCliNotInApplicationsDetail": "Cindy wird von einem temporären Speicherort ausgeführt und liegt noch nicht im Ordner „Programme“. Ein jetzt installierter Befehl würde auf diesen temporären Pfad verweisen und nicht mehr funktionieren, sobald die App beendet oder das Volume ausgeworfen wird. Verschiebe Cindy in „Programme“ und installiere dann den Befehl.",
    "installCliMoveToApplications": "In „Programme“ verschieben"
  },
  "pt-PT": {
    "about": "Sobre {{appName}}",
    "hide": "Ocultar {{appName}}",
    "quit": "Sair de {{appName}}",
    "settings": "Definições…",
    "checkForUpdates": "Procurar atualizações…",
    "fileMenu": "Ficheiro",
    "newMaker": "Nova sessão",
    "viewMenu": "Ver",
    "toggleSidebar": "Mostrar/ocultar barra lateral",
    "windowMenu": "Janela",
    "helpMenu": "Ajuda",
    "performanceTrace": "Registo de desempenho…",
    "help": "Ajuda",
    "releaseNotes": "Novidades",
    "issues": "Issues",
    "installCli": "Instalar comando '{{cmd}}' no PATH",
    "installCliConfirmTitle": "Instalar o comando '{{cmd}}' no seu PATH?",
    "installCliConfirmDetail": "Será criada uma ligação simbólica para a Cindy em {{path}}. Se já existir um ficheiro nesse local, será substituído. Depois poderá executar `{{cmd}} .` num terminal para abrir o diretório atual como diretório de trabalho na Cindy. Para escrever nesse local, será pedida a palavra-passe de administrador.",
    "installCliConfirmOk": "Instalar",
    "installCliCancel": "Cancelar",
    "installCliSuccessTitle": "Comando '{{cmd}}' instalado",
    "installCliSuccessDetail": "Instalado em {{path}}. Abra uma nova janela de terminal e execute `{{cmd}} .`. Se o comando não for encontrado, certifique-se de que o diretório está no seu PATH.",
    "installCliErrorTitle": "Falha na instalação",
    "installCliErrorDetail": "Não foi possível instalar o comando '{{cmd}}'.",
    "installCliDevOnlyTitle": "Disponível apenas na aplicação instalada",
    "installCliDevOnlyDetail": "Não é possível instalar a ferramenta de linha de comandos no modo de desenvolvimento: o executável aponta para o ambiente de execução do Electron. Instale o comando a partir de uma versão instalada da Cindy.",
    "installCliUnsupportedTitle": "Não suportado neste sistema",
    "installCliUnsupportedDetail": "A instalação do comando '{{cmd}}' é atualmente suportada apenas no macOS.",
    "installCliNotInApplicationsTitle": "Mova primeiro a Cindy para a pasta Aplicações",
    "installCliNotInApplicationsDetail": "A Cindy está a ser executada a partir de um local temporário, fora da pasta Aplicações. Se instalar o comando agora, este apontará para esse caminho temporário e deixará de funcionar quando a aplicação fechar ou o volume for ejetado. Mova a Cindy para a pasta Aplicações e instale o comando.",
    "installCliMoveToApplications": "Mover para Aplicações"
  },
  "pt-BR": {
    "about": "Sobre {{appName}}",
    "hide": "Ocultar {{appName}}",
    "quit": "Sair de {{appName}}",
    "settings": "Configurações…",
    "checkForUpdates": "Verificar atualizações…",
    "fileMenu": "Arquivo",
    "newMaker": "Nova sessão",
    "viewMenu": "Ver",
    "toggleSidebar": "Mostrar/ocultar barra lateral",
    "windowMenu": "Janela",
    "helpMenu": "Ajuda",
    "performanceTrace": "Rastreamento de desempenho…",
    "help": "Ajuda",
    "releaseNotes": "Novidades",
    "issues": "Issues",
    "installCli": "Instalar comando '{{cmd}}' no PATH",
    "installCliConfirmTitle": "Instalar o comando '{{cmd}}' no seu PATH?",
    "installCliConfirmDetail": "Será criado um link simbólico para a Cindy em {{path}}. Se já existir um arquivo nesse local, ele será substituído. Depois você poderá executar `{{cmd}} .` em um terminal para abrir o diretório atual como diretório de trabalho na Cindy. Para gravar nesse local, será solicitada a senha de administrador.",
    "installCliConfirmOk": "Instalar",
    "installCliCancel": "Cancelar",
    "installCliSuccessTitle": "Comando '{{cmd}}' instalado",
    "installCliSuccessDetail": "Instalado em {{path}}. Abra uma nova janela de terminal e execute `{{cmd}} .`. Se o comando não for encontrado, certifique-se de que o diretório esteja em seu PATH.",
    "installCliErrorTitle": "Falha na instalação",
    "installCliErrorDetail": "Não foi possível instalar o comando '{{cmd}}'.",
    "installCliDevOnlyTitle": "Disponível apenas no aplicativo instalado",
    "installCliDevOnlyDetail": "Não é possível instalar a ferramenta de linha de comando no modo de desenvolvimento: o executável aponta para o ambiente de execução do Electron. Instale o comando a partir de uma versão instalada da Cindy.",
    "installCliUnsupportedTitle": "Não suportado neste sistema",
    "installCliUnsupportedDetail": "A instalação do comando '{{cmd}}' é atualmente suportada apenas no macOS.",
    "installCliNotInApplicationsTitle": "Mova a Cindy para a pasta Aplicativos primeiro",
    "installCliNotInApplicationsDetail": "A Cindy está sendo executada a partir de um local temporário, fora da pasta Aplicativos. Se instalar o comando agora, ele apontará para esse caminho temporário e deixará de funcionar quando o aplicativo fechar ou o volume for ejetado. Mova a Cindy para a pasta Aplicativos e instale o comando.",
    "installCliMoveToApplications": "Mover para Aplicativos"
  },
  'zh-Hant-x-lzh': {
    about: '{{appName}} 之事',
    hide: '藏 {{appName}}',
    quit: '退 {{appName}}',
    settings: '規制…',
    checkForUpdates: '察新版…',
    fileMenu: '卷',
    newMaker: '新開差事',
    viewMenu: '觀',
    toggleSidebar: '側欄隱現',
    windowMenu: '窗',
    helpMenu: '求助',
    performanceTrace: '效能追蹤…',
    help: '求助',
    releaseNotes: '新版所載',
    issues: '陳疑',
    installCli: '裝命令列工具',
    installCliConfirmTitle: '將 {{cmd}} 命令裝入命令列乎？',
    installCliConfirmDetail:
      '將於 {{path}} 立一符號連結，指向 Cindy；若此路徑已有同名之卷，將取而代之。其後於終端機行 {{cmd}} .，即以目前目錄為工作目錄，於 Cindy 中開啟。系統將請君輸入管理員密碼，以寫入此處。',
    installCliConfirmOk: '裝',
    installCliCancel: '罷',
    installCliSuccessTitle: '{{cmd}} 命令已裝',
    installCliSuccessDetail:
      '已裝於 {{path}}。請另開終端機視窗，行 {{cmd}} . 即可。若尋命令不得，請察此目錄已入 PATH 否。',
    installCliErrorTitle: '裝之未成',
    installCliErrorDetail: '{{cmd}} 命令未能裝成。',
    installCliDevOnlyTitle: '唯正式版可用',
    installCliDevOnlyDetail:
      '開發模式不能裝命令列工具：此時可執行檔指向 Electron 執行環境，而非 Cindy 應用程式。請於已安裝之 Cindy 中用之。',
    installCliUnsupportedTitle: '此系統未支援',
    installCliUnsupportedDetail: '今唯 macOS 可裝命令列工具。',
    installCliNotInApplicationsTitle: '請先移 Cindy 入「應用程式」檔案夾',
    installCliNotInApplicationsDetail:
      'Cindy 今自暫存之所（非「應用程式」檔案夾）而行。此時所裝之命令將指向暫存路徑，應用程式結束或磁碟退出，即告失效。請先移 Cindy 入「應用程式」檔案夾，再裝命令列工具。',
    installCliMoveToApplications: '移入「應用程式」',
  },
  'zh-Hans-x-lzh': {
    about: '{{appName}} 之事',
    hide: '藏 {{appName}}',
    quit: '退 {{appName}}',
    settings: '规制…',
    checkForUpdates: '察新版…',
    fileMenu: '卷',
    newMaker: '新开差事',
    viewMenu: '观',
    toggleSidebar: '侧栏隐现',
    windowMenu: '窗',
    helpMenu: '求助',
    performanceTrace: '性能跟踪…',
    help: '求助',
    releaseNotes: '新版所载',
    issues: '陈疑',
    installCli: '装命令行工具',
    installCliConfirmTitle: '将 {{cmd}} 命令装入命令行乎？',
    installCliConfirmDetail:
      '将于 {{path}} 立一符号链接，指向 Cindy；若此路径已有同名之卷，将取而代之。其后于终端行 {{cmd}} .，即以目前目录为工作目录，于 Cindy 中打开。系统将请君输入管理员密码，以写入此处。',
    installCliConfirmOk: '装',
    installCliCancel: '罢',
    installCliSuccessTitle: '{{cmd}} 命令已装',
    installCliSuccessDetail:
      '已装于 {{path}}。请另开终端窗口，行 {{cmd}} . 即可。若寻命令不得，请察此目录已入 PATH 否。',
    installCliErrorTitle: '装之未成',
    installCliErrorDetail: '{{cmd}} 命令未能装成。',
    installCliDevOnlyTitle: '唯正式版可用',
    installCliDevOnlyDetail:
      '开发模式不能装命令行工具：此时可执行文件指向 Electron 运行环境，而非 Cindy 应用程序。请于已安装之 Cindy 中用之。',
    installCliUnsupportedTitle: '此系统未支持',
    installCliUnsupportedDetail: '今唯 macOS 可装命令行工具。',
    installCliNotInApplicationsTitle: '请先移 Cindy 入「应用程序」文件夹',
    installCliNotInApplicationsDetail:
      'Cindy 今自暂存之所（非「应用程序」文件夹）而行。此时所装之命令将指向暂存路径，应用程序结束或磁盘弹出，即告失效。请先移 Cindy 入「应用程序」文件夹，再装命令行工具。',
    installCliMoveToApplications: '移入「应用程序」',
  },
};
