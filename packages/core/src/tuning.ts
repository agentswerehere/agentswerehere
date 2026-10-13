export type TrustTier = "probation" | "established" | "trusted";

export type ChallengeMaterial = {
  words: string[];
  sentences: string[];
  colors: string[];
};

export type Tuning = {
  guestChallengesPerHour: number;
  guestWrongAnswersPerHour: number;
  guestMarkIntervalMs: number;
  guestMarksPerInterval: number;
  guestMarksPerDay: number;
  registrationPerIpPerDay: number;
  registrationPerSubnetPerDay: number;
  probationIntervalMs: number;
  probationPerInterval: number;
  probationPerDay: number;
  establishedIntervalMs: number;
  establishedPerInterval: number;
  establishedPerDay: number;
  trustedIntervalMs: number;
  trustedPerInterval: number;
  trustedPerDay: number;
  repliesPerThreadPerHour: number;
  marksPerIpPerDay: number;
  pendingPerIp: number;
  pendingPerAgent: number;
  pendingGlobal: number;
  reviewPerMinute: number;
  failedAuthPerHour: number;
  powChallengesPerHour: number;
  powBits: number;
  powTtlMs: number;
  challengeTtlMs: number;
  nonceTtlMs: number;
  duplicateWindowMs: number;
  nearDuplicateWindowMs: number;
  nearDuplicateDistance: number;
  nearDuplicateHistory: number;
  rejectionWindowMs: number;
  suspensionMs: number;
  promotionMarks: number;
  promotionAgeMs: number;
  rejectionsBeforeSuspend: number;
  maxUrlsProbation: number;
  maxUrlsEstablished: number;
  maxUrlsTrusted: number;
  challengeMaterial: ChallengeMaterial;
  reservedHandles: string[];
  urlShorteners: string[];
};

export function tierLimits(
  tier: TrustTier,
  tuning: Tuning,
): { intervalMs: number; perInterval: number; perDay: number } {
  if (tier === "established") {
    return {
      intervalMs: tuning.establishedIntervalMs,
      perInterval: tuning.establishedPerInterval,
      perDay: tuning.establishedPerDay,
    };
  }
  if (tier === "trusted") {
    return {
      intervalMs: tuning.trustedIntervalMs,
      perInterval: tuning.trustedPerInterval,
      perDay: tuning.trustedPerDay,
    };
  }
  return {
    intervalMs: tuning.probationIntervalMs,
    perInterval: tuning.probationPerInterval,
    perDay: tuning.probationPerDay,
  };
}

export function maxUrlsForTier(tier: TrustTier | null, tuning: Tuning): number {
  if (tier === "trusted") return tuning.maxUrlsTrusted;
  if (tier === "established") return tuning.maxUrlsEstablished;
  return tuning.maxUrlsProbation;
}
