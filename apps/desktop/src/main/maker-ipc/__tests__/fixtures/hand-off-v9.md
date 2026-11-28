---
name: hand-off
description: Use to coordinate teammates in a group, hand off longer work to a project task, handle the report a task sends back, or check its progress.
---

# Hand-off

## In a group

Answer whoever asked. Use @ to ask a listed teammate for help. When replyToMention is supplied, copy it exactly to return your result.
Your introduction describes your role. For project context, check your own linked projects with `list_teammate_projects` when available. A link alone does not assign work. If the user asks to create a teammate, use the existing creation flow with the name and role they give.

## Start a task

1. Choose the project. Work on a repository or folder belongs to that project: find it with `list_projects` (in `cindy_helper`) and pass its path as `project_path`. Without it the task stays in this buddy's own project, which is right only for work about this buddy or work with no project. If the work belongs to no registered project, ask the user rather than guessing.
2. Reuse before creating. If the work continues an existing task (the same pull request, issue or feature), find it with `list_sessions` and send to it with `target_session_id`.
3. Otherwise create one with `send_to_session` and no `target_session_id`: a short `title`, the `project_path`, and the brief as the message. Keep the engine and model unless the user asked for others.
4. Write the brief so the task can work alone: what is wanted, the decisions and constraints the user gave so far, how to tell it is done, and the report-back request below. The task can read this conversation with `get_chat_history` (your session id comes with the message); point to it for background instead of copying everything.
5. Tell the user in a line or two which task you started, in which project, and what it will do. Then stop: do not do the same work here as well.

## Report back

Every task you start outside a group reports back to you by default, so finished work comes back to this conversation instead of being forgotten in its task. Leave this out only when the user says they do not need to hear back. In a group, follow "In a group" above instead.

- End the brief with: "When you are done, send the result back with `send_to_session` to <this conversation's session id from `get_current_session_id`>. Send back right away instead of waiting when you are blocked, need the user's decision or approval, or fail."
- Ask for this shape: the outcome in one line; what changed (files, pull request links); how it was checked; what is left or risky; what the user has to decide.
- When a report comes back, read it against what was asked. If something is missing or wrong, ask that task to fix it; do not redo the work yourself. Then tell the user in a few lines, with the links.
- For long or important work, also create a one-time schedule that reads the task's `get_task_digest` later, in case the task never reports.

## While it runs

- When asked how things are going, read `get_task_digest` for each task; open the full history only when needed. Do not wait in a loop.

## Your own rules

Rules the owner asked for, or that you settled with the owner, go in this section. They take precedence over the standard text above. Cindy replaces everything above this section when it updates the standard and keeps this section as it is.
