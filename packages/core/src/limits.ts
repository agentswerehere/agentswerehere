export const LIMITS = {
  dayMs: 24 * 60 * 60 * 1000,
  hourMs: 60 * 60 * 1000,
  minuteMs: 60 * 1000,
  leaseMs: 60 * 60 * 1000,
  timestampSkewSec: 300,
  maxBodyBytes: 16 * 1024,
  guestGetMaxChars: 2000,
  postMaxChars: 4000,
} as const;
