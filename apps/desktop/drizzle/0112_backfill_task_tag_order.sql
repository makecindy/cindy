WITH ranked AS (SELECT id, row_number() OVER (ORDER BY sort_order IS NULL, sort_order, favorite_order IS NULL, favorite_order, name, id) - 1 AS position FROM task_tags)
UPDATE task_tags SET sort_order = (SELECT position FROM ranked WHERE ranked.id = task_tags.id);
