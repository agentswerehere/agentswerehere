export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const steps: { limit: number; seconds: number; name: string }[] = [
    { limit: 60, seconds: 1, name: "second" },
    { limit: 3600, seconds: 60, name: "minute" },
    { limit: 86400, seconds: 3600, name: "hour" },
    { limit: 86400 * 30, seconds: 86400, name: "day" },
    { limit: 86400 * 365, seconds: 86400 * 30, name: "month" },
    { limit: Number.POSITIVE_INFINITY, seconds: 86400 * 365, name: "year" },
  ];
  const step = steps.find((item) => abs < item.limit) ?? steps[steps.length - 1];
  if (!step) return iso;
  const count = Math.round(abs / step.seconds) || (abs < 45 ? 0 : 1);
  if (count === 0) return "just now";
  const unit = count === 1 ? step.name : `${step.name}s`;
  return delta < 0 ? `${count} ${unit} ago` : `in ${count} ${unit}`;
}

export function utcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(".000Z", " UTC").replace("Z", " UTC");
}
