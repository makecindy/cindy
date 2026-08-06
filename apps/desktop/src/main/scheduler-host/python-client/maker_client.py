#!/usr/bin/env python3
"""Cindy Desktop script-task Python client. No network endpoint or credential."""

from __future__ import annotations

from typing import IO, Any

from protocol import DuplexClient, RpcError

DEFAULT_TIMEOUT = 30


class MakerClientError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if code else message)


_client = DuplexClient()


def _client_for_test(reader: IO[str], writer: IO[str]) -> None:
    global _client
    _client = DuplexClient(reader=reader, writer=writer)


def call_rpc(method: str, params: dict, timeout: int = DEFAULT_TIMEOUT) -> Any:
    try:
        return _client.call(method, params, timeout=timeout)
    except RpcError as error:
        raise MakerClientError(error.code, error.message) from None


def emit_complete(result_text: str, primary_session_id: str | None = None) -> None:
    _client.emit_complete(result_text, primary_session_id)


def host_capabilities() -> dict:
    """自省(免授权):返回 {protocol, granted: [能力], methods: [方法目录]}。

    脚本可先 list 再决定怎么 call,按 granted 优雅分支,替代盲调撞
    CAPABILITY_DENIED。"""
    return call_rpc("host.capabilities", {})


def jira_issue_get(
    issue_key: str, fields: list[str] | None = None, out_file: str | None = None
) -> dict:
    """按 key 读单条 Jira issue。

    out_file = 把整包结果落盘到任务工作目录下的相对路径(大结果防截断;
    路径安全校验由宿主把关),返回值带 saved_to 相对路径,脚本从自己 cwd 读回。"""
    params: dict[str, Any] = {"issue_key": issue_key}
    if fields:
        params["fields"] = fields
    if out_file is not None:
        params["out_file"] = out_file
    return call_rpc("jira.get", params)


def jira_issues_search_jql(
    jql: str,
    fields: list[str] | None = None,
    max_results: int | None = None,
    next_page_token: str | None = None,
    out_file: str | None = None,
) -> dict:
    """JQL 搜索。大结果集两条路:next_page_token 翻页,或 out_file 落盘
    (任务工作目录内相对路径)后自己读回——宿主对单次响应有体积上限。"""
    params: dict[str, Any] = {"jql": jql}
    if fields:
        params["fields"] = fields
    if max_results is not None:
        params["max_results"] = max_results
    if next_page_token:
        params["next_page_token"] = next_page_token
    if out_file is not None:
        params["out_file"] = out_file
    return call_rpc("jira.search_jql", params)


def jira_issue_add_comment(
    issue_key: str,
    body_text: str | None = None,
    body_adf: dict | None = None,
) -> dict:
    """向 Jira issue 添加评论。body_text(纯文本)与 body_adf(ADF 文档对象,
    支持真实 @mention)恰好二选一;两个都传或都不传宿主会拒收(INVALID_ARGS)。"""
    params: dict[str, Any] = {"issue_key": issue_key}
    if body_text is not None:
        params["body_text"] = body_text
    if body_adf is not None:
        params["body_adf"] = body_adf
    return call_rpc("jira.add_comment", params)


def feishu_recent_chats(count: int = 20) -> dict:
    """按活跃时间倒序列最近会话(群/单聊)。bot 入口轮询的第一步。"""
    return call_rpc("feishu.recent_chats", {"count": count})


def feishu_recent_messages(chat_id: str, count: int = 20, start_time: str | None = None) -> dict:
    """拉取指定飞书会话最近 count 条消息,新->旧,含 sender_name。

    start_time(Unix 秒/毫秒或 ISO 字符串)= 增量游标:只取该时刻之后的消息。
    """
    params = {"chat_id": chat_id, "count": count}
    if start_time:
        params["start_time"] = start_time
    return call_rpc("feishu.recent_messages", params)


def sessions_dispatch(
    message: str,
    title: str = "",
    target_session_id: str | None = None,
) -> dict:
    """创建或唤醒 Cindy 会话并投递消息。

    只允许这三个参数——新会话的 agent/model/目录等配置由宿主从任务本身派生,
    dispatcher_session_id / use_worktree 等 host-owned 参数脚本传了会被直接拒绝
    (INVALID_ARGS),这是防冒充设计,不是遗漏。"""
    params: dict[str, Any] = {"message": message}
    if title:
        params["title"] = title
    if target_session_id:
        params["target_session_id"] = target_session_id
    return call_rpc("sessions.dispatch", params)
