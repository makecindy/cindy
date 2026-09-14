export function skillPublisherLabel(skill: {
  authorName: string;
  publisherName?: string;
}): string {
  const owner = skill.authorName.trim();
  const publisher = skill.publisherName?.trim() ?? '';
  if (!publisher || publisher === owner) return owner || publisher;
  if (!owner) return publisher;
  return `${publisher} · ${owner}`;
}
