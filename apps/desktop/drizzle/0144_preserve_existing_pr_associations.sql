UPDATE `session_pr_refs`
SET `association_source` = 'explicit',
    `association_origin` = COALESCE(`association_origin`, 'upgrade')
WHERE `association_source` = 'legacy' AND `removed_at` IS NULL;
