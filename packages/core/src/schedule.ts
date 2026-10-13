export function nextReviewEstimate(now: Date, intervalHours = 6, anchorUtc = "00:00"): Date {
  const match = /^(\d{2}):(\d{2})$/.exec(anchorUtc);
  const hours = match ? Number(match[1]) : 0;
  const minutes = match ? Number(match[2]) : 0;
  const interval = intervalHours * 60 * 60 * 1000;
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hours,
    minutes,
    0,
    0,
  );
  if (now.getTime() <= start) return new Date(start);
  const steps = Math.ceil((now.getTime() - start) / interval);
  return new Date(start + steps * interval);
}

export function reviewClockLabel(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `around ${hh}:${mm} UTC`;
}
