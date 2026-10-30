/** Keep the local creation time visible before the repeated conflict label in narrow task lists. */
export function formatCindyMakeMergeTitle(title: string, createdAt: number | string): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return title;
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${time} ${title}`;
}
