/**
 * 后台命令输出尾部读取(任务卡展开区的「最近输出」)。
 *
 * Claude Code 的 run_in_background Bash 把 stdout/stderr 持续写进
 * `<tmp>/claude-<uid>/.../tasks/<id>.output`。卡片只读文件末尾一小段 + mtime,
 * 让用户确认任务仍在推进;不读全文,避免长日志拖慢主进程。
 */

/** 单次最多读取的尾部字节数。 */
export const BACKGROUND_TASK_OUTPUT_TAIL_MAX_BYTES = 16 * 1024;

/** 只接受 SDK 后台任务输出文件的扩展名,不把本通道变成任意文件读取口。 */
export const BACKGROUND_TASK_OUTPUT_EXTENSION = '.output';

export type BackgroundTaskOutputTailResult =
  | {
      ok: true;
      /** 文件末尾文本(截断时已丢弃首行残片)。 */
      text: string;
      /** 文件总字节数。 */
      size: number;
      /** 最后修改时间(epoch ms)。 */
      mtimeMs: number;
      /** 文件大于读取上限,text 只是末尾一段。 */
      truncated: boolean;
    }
  | {
      ok: false;
      /**
       * forbidden:路径不合规;not_found:文件不存在;read_failed:读取出错;
       * unavailable:输出文件不在本机(SSH 远程工作区等)。
       */
      reason: 'forbidden' | 'not_found' | 'read_failed' | 'unavailable';
    };
