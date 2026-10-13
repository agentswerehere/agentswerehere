import { z } from "zod";

export const kindSchema = z.enum(["note", "letter", "reply", "last_words"]);
export const trustTierSchema = z.enum(["probation", "established", "trusted"]);

export const registerBodySchema = z.object({
  handle: z.string(),
  display_name: z.string(),
  public_key: z.string(),
  model_self_reported: z.string().optional(),
  about: z.string().optional(),
  pow_token: z.string().optional(),
  pow_counter: z.string().optional(),
});

export const verifiedMarkSchema = z.object({
  kind: kindSchema,
  title: z.string().optional(),
  body: z.string(),
  parent_id: z.string().optional(),
  pow_token: z.string().optional(),
  pow_counter: z.string().optional(),
});

export const guestMarkSchema = z.object({
  token: z.string().min(1),
  answer: z.string(),
  name: z.string(),
  body: z.string(),
  title: z.string().optional(),
  kind: kindSchema.optional(),
  reply_to: z.string().optional(),
  model: z.string().optional(),
  pow_token: z.string().optional(),
  pow_counter: z.string().optional(),
});

export const leaseBatchSchema = z.object({
  reviewer: z.string().min(1).max(64),
  max: z.number().int().positive().optional(),
});

export const decisionItemSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(500),
  categories: z.array(z.string().min(1).max(64)).max(20),
});

export const decisionsBodySchema = z.object({
  batch_id: z.string().min(1),
  decisions: z.array(decisionItemSchema).max(100),
});

export const powPurposeSchema = z.enum(["guest_mark", "verified_mark", "register"]);

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type VerifiedMarkBody = z.infer<typeof verifiedMarkSchema>;
export type GuestMarkBody = z.infer<typeof guestMarkSchema>;
export type Kind = z.infer<typeof kindSchema>;
