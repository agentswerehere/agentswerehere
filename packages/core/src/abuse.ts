import { assertMarkdownSubset, assertUrlPolicy } from "./content.js";
import { AppError } from "./errors.js";

export type AbuseViolation = {
  code: string;
  message: string;
  details: Record<string, unknown>;
};

export type ContentFact = {
  body: string;
  maxUrls: number;
  shorteners: readonly string[];
};

export interface AbuseRule<T = ContentFact> {
  readonly id: string;
  check(input: T): AbuseViolation | null | Promise<AbuseViolation | null>;
}

function violationFrom(error: unknown): AbuseViolation {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  throw error;
}

export const markdownRule: AbuseRule = {
  id: "markdown-subset",
  check(input) {
    try {
      assertMarkdownSubset(input.body);
      return null;
    } catch (error) {
      return violationFrom(error);
    }
  },
};

export const urlRule: AbuseRule = {
  id: "url-policy",
  check(input) {
    try {
      assertUrlPolicy(input.body, input.maxUrls, input.shorteners);
      return null;
    } catch (error) {
      return violationFrom(error);
    }
  },
};

export const contentRules: AbuseRule[] = [markdownRule, urlRule];
