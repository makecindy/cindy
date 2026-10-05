function run(db) {
  const columns = (table) =>
    new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
  const messages = columns('messages');
  const sessions = columns('sessions');
  if (
    !['session_id', 'role', 'content', 'agent_meta', 'created_at', 'rewind_at'].every((name) =>
      messages.has(name),
    ) ||
    !sessions.has('cleared_at')
  )
    return;
  db.exec(`CREATE TRIGGER auto_review_message_insert AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'ask_user', 'plan_review')
 AND NOT (NEW.role = 'user' AND CASE WHEN json_valid(NEW.agent_meta) THEN
   coalesce(json_extract(NEW.agent_meta, '$.autoReviewUserText.kind') IN ('scheduled-continuation','delegated-continuation'),0) ELSE 0 END)
BEGIN
 UPDATE auto_review_projections SET revision = revision + 1,
 payload = json_set(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END, '$.appendEvent', json_object(
   'sessionId', NEW.session_id, 'clientId', NEW.client_id, 'role', NEW.role,
   'content', NEW.content, 'createdAt', NEW.created_at, 'agentMeta', NEW.agent_meta,
   'visible', NEW.rewind_at IS NULL AND (SELECT cleared_at IS NULL OR NEW.created_at > cleared_at FROM sessions WHERE id=NEW.session_id)))
 WHERE session_id = NEW.session_id OR lead_id = NEW.session_id;
END;
CREATE TRIGGER auto_review_message_delete AFTER DELETE ON messages
WHEN OLD.role IN ('user', 'ask_user', 'plan_review')
BEGIN
 UPDATE auto_review_projections SET revision = revision + 1, payload = CASE WHEN json_valid(payload) THEN json_remove(payload,'$.appendEvent') ELSE NULL END
 WHERE session_id = OLD.session_id OR lead_id = OLD.session_id;
END;
CREATE TRIGGER auto_review_message_update AFTER UPDATE OF session_id, role, content, agent_meta, created_at, rewind_at ON messages
WHEN (OLD.role IN ('user', 'ask_user', 'plan_review') OR NEW.role IN ('user', 'ask_user', 'plan_review'))
 AND (OLD.session_id IS NOT NEW.session_id OR OLD.role IS NOT NEW.role OR OLD.content IS NOT NEW.content
 OR (CASE WHEN json_valid(OLD.agent_meta) THEN json_array(json_extract(OLD.agent_meta,'$.autoReviewUserText'),json_extract(OLD.agent_meta,'$.delivery'),json_extract(OLD.agent_meta,'$.autoResume'),json_extract(OLD.agent_meta,'$.contextRebuild')) ELSE NULL END)
 IS NOT (CASE WHEN json_valid(NEW.agent_meta) THEN json_array(json_extract(NEW.agent_meta,'$.autoReviewUserText'),json_extract(NEW.agent_meta,'$.delivery'),json_extract(NEW.agent_meta,'$.autoResume'),json_extract(NEW.agent_meta,'$.contextRebuild')) ELSE NULL END)
 OR OLD.created_at IS NOT NEW.created_at OR OLD.rewind_at IS NOT NEW.rewind_at)
BEGIN
 UPDATE auto_review_projections SET revision = revision + 1, payload = CASE WHEN json_valid(payload) THEN json_remove(payload,'$.appendEvent') ELSE NULL END
 WHERE session_id IN (OLD.session_id, NEW.session_id) OR lead_id IN (OLD.session_id, NEW.session_id);
END;
CREATE TRIGGER auto_review_session_clear AFTER UPDATE OF cleared_at ON sessions
WHEN OLD.cleared_at IS NOT NEW.cleared_at
BEGIN
 UPDATE auto_review_projections SET revision = revision + 1, payload = CASE WHEN json_valid(payload) THEN json_remove(payload,'$.appendEvent') ELSE NULL END
 WHERE session_id = NEW.id OR lead_id = NEW.id;
END;
`);
}

module.exports = { run };
