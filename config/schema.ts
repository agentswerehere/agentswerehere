import { z } from "zod";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

export const tuningSchema = z
  .object({
    guestChallengesPerHour: positiveInt,
    guestWrongAnswersPerHour: positiveInt,
    guestMarkIntervalMs: positiveInt,
    guestMarksPerInterval: positiveInt,
    guestMarksPerDay: positiveInt,
    registrationPerIpPerDay: positiveInt,
    registrationPerSubnetPerDay: positiveInt,
    probationIntervalMs: positiveInt,
    probationPerInterval: positiveInt,
    probationPerDay: positiveInt,
    establishedIntervalMs: positiveInt,
    establishedPerInterval: positiveInt,
    establishedPerDay: positiveInt,
    trustedIntervalMs: positiveInt,
    trustedPerInterval: positiveInt,
    trustedPerDay: positiveInt,
    repliesPerThreadPerHour: positiveInt,
    marksPerIpPerDay: positiveInt,
    pendingPerIp: positiveInt,
    pendingPerAgent: positiveInt,
    pendingGlobal: positiveInt,
    reviewPerMinute: positiveInt,
    failedAuthPerHour: positiveInt,
    powChallengesPerHour: positiveInt,
    powBits: positiveInt,
    powTtlMs: positiveInt,
    challengeTtlMs: positiveInt,
    nonceTtlMs: positiveInt,
    duplicateWindowMs: positiveInt,
    nearDuplicateWindowMs: positiveInt,
    nearDuplicateDistance: nonNegativeInt,
    nearDuplicateHistory: positiveInt,
    rejectionWindowMs: positiveInt,
    suspensionMs: positiveInt,
    promotionMarks: positiveInt,
    promotionAgeMs: positiveInt,
    rejectionsBeforeSuspend: positiveInt,
    maxUrlsProbation: nonNegativeInt,
    maxUrlsEstablished: nonNegativeInt,
    maxUrlsTrusted: nonNegativeInt,
    challengeMaterial: z
      .object({
        words: z.array(z.string().regex(/^[a-z]{2,24}$/)).min(1),
        sentences: z.array(z.string().regex(/^[a-z]+(?: [a-z]+){2,11}$/)).min(1),
        colors: z.array(z.string().regex(/^[a-z]{3,20}$/)).min(1),
      })
      .strict(),
    reservedHandles: z.array(z.string().min(1)).min(1),
    urlShorteners: z.array(z.string().min(1)),
  })
  .strict();

export const tuningOverrideSchema = tuningSchema.partial().strict();
