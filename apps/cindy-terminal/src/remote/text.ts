import { resolveRemoteText, type RemoteLocalizedText } from '@cindy/device-link';
const rows:Record<string,readonly string[]> = {
  "Share this screen": ["共享本机屏幕", "共享此電腦螢幕", "この画面を共有", "이 화면 공유"],
  "Screen permissions": ["屏幕权限", "螢幕權限", "画面の権限", "화면 권한"],
  "Screen recording": ["屏幕录制", "螢幕錄製", "画面収録", "화면 기록"],
  "Accessibility": ["辅助功能", "輔助使用", "アクセシビリティ", "손쉬운 사용"],
  "Granted": ["已授权", "已授權", "許可済み", "허용됨"],
  "Not granted": ["未授权", "未授權", "未許可", "허용되지 않음"],
  "Not required": ["无需权限", "無需權限", "不要", "필요 없음"],
  "Connect to device": ["连接设备", "連線裝置", "デバイスに接続", "기기에 연결"],
  "Disconnect device": ["断开设备", "中斷裝置連線", "デバイスを切断", "기기 연결 해제"],
  "Enable device control": ["开启对这台设备的控制", "開啟對此裝置的控制", "このデバイスの制御を有効化", "이 기기 제어 켜기"],
  "Disable device control": ["关闭对这台设备的控制", "關閉對此裝置的控制", "このデバイスの制御を無効化", "이 기기 제어 끄기"],
  "Revoke access to this computer": ["撤销访问本机的权限", "撤銷存取本機的權限", "このコンピューターへのアクセスを取り消す", "이 컴퓨터 접근 권한 철회"],
  "Restore access to this computer": ["恢复访问本机的权限", "恢復存取本機的權限", "このコンピューターへのアクセスを復元", "이 컴퓨터 접근 권한 복원"],
  "Rename device": ["重命名设备", "重新命名裝置", "デバイスの名前を変更", "기기 이름 변경"],
  "Remove offline device": ["移除离线设备", "移除離線裝置", "オフラインのデバイスを削除", "오프라인 기기 삭제"],
  "Permissions": ["权限", "權限", "権限", "권한"],
  "Ask": ["询问", "詢問", "確認する", "확인"],
  "Auto-review": ["自动审批", "自動審批", "自動承認", "자동 승인"],
  "Auto accept edits": ["自动接受编辑", "自動接受編輯", "編集を自動承認", "편집 자동 승인"],
  "Full access": ["完全访问", "完全存取", "フルアクセス", "전체 액세스"],
  "Allow this teammate to run tools without asking for permission?": ["允许此伙伴执行工具时不再询问权限？", "允許此夥伴執行工具時不再詢問權限？", "この仲間が権限の確認なしでツールを実行することを許可しますか？", "이 팀원이 권한을 묻지 않고 도구를 실행하도록 허용할까요?"],
"order":["按优先顺序","依優先順序","優先順位順","우선순위 순"],"weight":["按权重分配","依權重分配","重み付き割り当て","가중치 분배"],"usage":["按用量分配","依用量分配","使用量に応じて割り当て","사용량별 분배"],"available":["可用","可用","利用可能","사용 가능"],"full":["已满","已滿","上限に到達","가득 참"],"unknown":["未知","未知","不明","알 수 없음"],
  "Disable remote access": [
    "关闭远程调用",
    "關閉遠端呼叫",
    "リモート呼び出しを無効化",
    "원격 호출 끄기"
  ],
  "Enable remote access": [
    "开启远程调用",
    "開啟遠端呼叫",
    "リモート呼び出しを有効化",
    "원격 호출 켜기"
  ],
  "Create invitation": [
    "创建邀请",
    "建立邀請",
    "招待を作成",
    "초대 만들기"
  ],
  "Remote providers": [
    "远程供应商",
    "遠端供應商",
    "リモートプロバイダー",
    "원격 공급자"
  ],
  "Allow all models": [
    "允许全部模型",
    "允許全部模型",
    "すべてのモデルを許可",
    "모든 모델 허용"
  ],
  "Strategy": [
    "分配策略",
    "分配策略",
    "割り当て方法",
    "분배 방식"
  ],
  "Provider groups": [
    "供应商组",
    "供應商群組",
    "プロバイダーグループ",
    "공급자 그룹"
  ],
  "Add computer": [
    "添加电脑",
    "新增電腦",
    "コンピューターを追加",
    "컴퓨터 추가"
  ],
  "Computer": [
    "电脑",
    "電腦",
    "コンピューター",
    "컴퓨터"
  ],
  "Approve": [
    "同意",
    "同意",
    "承認",
    "승인"
  ],
  "Reject": [
    "拒绝",
    "拒絕",
    "拒否",
    "거절"
  ],
  "Forwarded sharing requests": [
    "转分享申请",
    "轉分享申請",
    "再共有の申請",
    "재공유 요청"
  ],
  "Leave share": [
    "退出分享",
    "退出分享",
    "共有から退出",
    "공유 나가기"
  ],
  "Invitation request": [
    "分享申请",
    "分享申請",
    "共有申請",
    "공유 요청"
  ],
  "Withdraw request": [
    "撤回申请",
    "撤回申請",
    "申請を取り消す",
    "요청 취소"
  ],
  "Provider sharing": [
    "供应商分享",
    "供應商分享",
    "プロバイダー共有",
    "공급자 공유"
  ],
  "Preview invitation": [
    "查看邀请",
    "查看邀請",
    "招待を確認",
    "초대 확인"
  ],
  "Invitation link": [
    "邀请链接",
    "邀請連結",
    "招待リンク",
    "초대 링크"
  ],
  "Request access": [
    "申请加入",
    "申請加入",
    "アクセスを申請",
    "접근 요청"
  ],
  "Stop sharing": [
    "停止共享",
    "停止共享",
    "共有を停止",
    "공유 중지"
  ],
  "Open task": [
    "打开任务",
    "開啟任務",
    "タスクを開く",
    "작업 열기"
  ],
  "Leave task": [
    "退出任务",
    "退出任務",
    "タスクから退出",
    "작업 나가기"
  ],
  "Shared tasks": [
    "共享任务",
    "共享任務",
    "共有タスク",
    "공유 작업"
  ],
  "Share a task": [
    "共享任务",
    "共享任務",
    "タスクを共有",
    "작업 공유"
  ],
  "Task ID": [
    "任务 ID",
    "任務 ID",
    "タスク ID",
    "작업 ID"
  ],
  "Join a task": [
    "加入任务",
    "加入任務",
    "タスクに参加",
    "작업 참여"
  ],
  "Display name": [
    "显示名称",
    "顯示名稱",
    "表示名",
    "표시 이름"
  ],
  "Remote access enabled": [
    "远程调用已开启",
    "遠端呼叫已開啟",
    "リモート呼び出し有効",
    "원격 호출 켜짐"
  ],
  "Remote access off": [
    "远程调用已关闭",
    "遠端呼叫已關閉",
    "リモート呼び出し無効",
    "원격 호출 꺼짐"
  ],
  "No group": [
    "未建立组",
    "未建立群組",
    "グループなし",
    "그룹 없음"
  ],
  "All offered models": [
    "全部可用模型",
    "全部可用模型",
    "提供される全モデル",
    "제공되는 모든 모델"
  ],
  "No models allowed": [
    "未允许任何模型",
    "未允許任何模型",
    "許可されたモデルなし",
    "허용된 모델 없음"
  ],
  "This computer": [
    "这台电脑",
    "這台電腦",
    "このコンピューター",
    "이 컴퓨터"
  ],
  "Remove {name}": [
    "移除 {name}",
    "移除 {name}",
    "{name} を削除",
    "{name} 삭제"
  ],
  "Pause {name}": [
    "暂停 {name}",
    "暫停 {name}",
    "{name} を一時停止",
    "{name} 일시 중지"
  ],
  "Resume {name}": [
    "恢复 {name}",
    "恢復 {name}",
    "{name} を再開",
    "{name} 재개"
  ],
  "Approve {name}": [
    "同意 {name}",
    "同意 {name}",
    "{name} を承認",
    "{name} 승인"
  ],
  "Reject {name}": [
    "拒绝 {name}",
    "拒絕 {name}",
    "{name} を拒否",
    "{name} 거절"
  ],
  "All models · {name}": [
    "全部模型 · {name}",
    "全部模型 · {name}",
    "全モデル · {name}",
    "모든 모델 · {name}"
  ],
  "Enable {name}": [
    "启用 {name}",
    "啟用 {name}",
    "{name} を有効化",
    "{name} 켜기"
  ],
  "Disable {name}": [
    "停用 {name}",
    "停用 {name}",
    "{name} を無効化",
    "{name} 끄기"
  ],
  "{members} members · {requests} requests": [
    "{members} 位成员 · {requests} 条申请",
    "{members} 位成員 · {requests} 則申請",
    "メンバー {members} 人 · 申請 {requests} 件",
    "멤버 {members}명 · 요청 {requests}개"
  ],
  "active": [
    "已启用",
    "已啟用",
    "有効",
    "활성"
  ],
  "paused": [
    "已暂停",
    "已暫停",
    "一時停止",
    "일시 중지"
  ],
  "pending": [
    "待处理",
    "待處理",
    "保留中",
    "대기 중"
  ],
  "approved": [
    "已同意",
    "已同意",
    "承認済み",
    "승인됨"
  ],
  "rejected": [
    "已拒绝",
    "已拒絕",
    "拒否済み",
    "거절됨"
  ],
  "revoked": [
    "已撤销",
    "已撤銷",
    "取り消し済み",
    "취소됨"
  ],
  "withdrawn": [
    "已撤回",
    "已撤回",
    "撤回済み",
    "철회됨"
  ],
  "expired": [
    "已过期",
    "已過期",
    "期限切れ",
    "만료됨"
  ],
  "online": [
    "在线",
    "在線",
    "オンライン",
    "온라인"
  ],
  "offline": [
    "离线",
    "離線",
    "オフライン",
    "오프라인"
  ],
  "ready": [
    "就绪",
    "就緒",
    "準備完了",
    "준비됨"
  ],
  "busy": [
    "忙碌",
    "忙碌",
    "実行中",
    "사용 중"
  ],
  "cooling": [
    "冷却中",
    "冷卻中",
    "待機中",
    "대기 중"
  ],
  "unavailable": [
    "不可用",
    "無法使用",
    "利用不可",
    "사용 불가"
  ],
  "least": [
    "优先空闲电脑",
    "優先空閒電腦",
    "空きが多い順",
    "여유 컴퓨터 우선"
  ],
  "round": [
    "轮流分配",
    "輪流分配",
    "順番に割り当て",
    "순환 분배"
  ],
  "priority": [
    "按优先顺序",
    "依優先順序",
    "優先順位順",
    "우선순위 순"
  ],
  "weighted": [
    "按权重分配",
    "依權重分配",
    "重み付き割り当て",
    "가중치 분배"
  ],
  "Teammates": [
    "伙伴",
    "夥伴",
    "チームメイト",
    "동료"
  ],
  "Add teammate": [
    "添加伙伴",
    "新增夥伴",
    "チームメイトを追加",
    "동료 추가"
  ],
  "Name": [
    "名字",
    "名字",
    "名前",
    "이름"
  ],
  "Description": [
    "简介",
    "簡介",
    "説明",
    "소개"
  ],
  "Open conversation": [
    "打开对话",
    "開啟對話",
    "会話を開く",
    "대화 열기"
  ],
  "Edit profile": [
    "编辑资料",
    "編輯資料",
    "プロフィールを編集",
    "프로필 편집"
  ],
  "Identity": [
    "身份",
    "身分",
    "アイデンティティ",
    "정체성"
  ],
  "Paused": [
    "已暂停",
    "已暫停",
    "一時停止",
    "일시 중지"
  ],
  "Ready": [
    "就绪",
    "就緒",
    "準備完了",
    "준비됨"
  ],
  "Save": [
    "保存",
    "儲存",
    "保存",
    "저장"
  ],
  "Delete teammate": [
    "删除伙伴",
    "刪除夥伴",
    "チームメイトを削除",
    "동료 삭제"
  ],
  "Pause": [
    "暂停",
    "暫停",
    "一時停止",
    "일시 중지"
  ],
  "Resume": [
    "恢复",
    "恢復",
    "再開",
    "재개"
  ],
  "Models": [
    "模型",
    "模型",
    "モデル",
    "모델"
  ],
  "Model": [
    "模型",
    "模型",
    "モデル",
    "모델"
  ],
  "Follow default model": [
    "使用默认模型",
    "使用預設模型",
    "既定のモデルを使用",
    "기본 모델 사용"
  ],
  "Primary computer": [
    "主力电脑",
    "主力電腦",
    "メインコンピューター",
    "주 컴퓨터"
  ],
  "Move here": [
    "迁移到这里",
    "移轉到這裡",
    "ここに移動",
    "여기로 이동"
  ],
  "Refresh": [
    "刷新",
    "重新整理",
    "更新",
    "새로 고침"
  ]
};
export function remoteText(fallback:string,_zh?:string,values:Record<string,string|number>={}):RemoteLocalizedText { const row=rows[fallback];if(!row)throw new Error('MISSING_REMOTE_TRANSLATION:'+fallback);const fill=(text:string)=>text.replace(/\{(\w+)\}/g,(_match,key:string)=>String(values[key]??'{'+key+'}'));return {fallback:fill(fallback),translations:{'zh-CN':fill(row[0]),'zh-TW':fill(row[1]),en:fill(fallback),ja:fill(row[2]),ko:fill(row[3])}};}
export function remoteString(key:string,locale?:string,values:Record<string,string|number>={}){return resolveRemoteText(remoteText(key,undefined,values),locale);}
