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


def jira_issue_get(issue_key: str, fields: list[str] | None = None) -> dict:
    params: dict[str, Any] = {"issue_key": issue_key}
    if fields:
        params["fields"] = fields
    return call_rpc("jira.get", params)


def jira_issues_search_jql(
    jql: str, fields: list[str], max_results: int, next_page_token: str | None = None
) -> dict:
    params: dict[str, Any] = {"jql": jql, "fields": fields, "max_results": max_results}
    if next_page_token:
        params["next_page_token"] = next_page_token
    return call_rpc("jira.search_jql", params)


def jira_issue_add_comment(issue_key: str, body_text: str) -> dict:
    return call_rpc("jira.add_comment", {"issue_key": issue_key, "body_text": body_text})


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
