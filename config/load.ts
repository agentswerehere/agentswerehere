import { readFileSync } from "node:fs";
import type { Tuning } from "@agentswerehere/core";
import { defaultTuning } from "./defaults.js";
import { tuningOverrideSchema, tuningSchema } from "./schema.js";

export function loadTuning(env: NodeJS.ProcessEnv = process.env): Tuning {
  const override = readOverride(env);
  return tuningSchema.parse({ ...defaultTuning, ...override });
}

function readOverride(env: NodeJS.ProcessEnv): Partial<Tuning> {
  const encoded = env.AWH_PRIVATE_CONFIG;
  if (encoded) {
    let text: string;
    try {
      text = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      throw new Error("AWH_PRIVATE_CONFIG is not valid base64.");
    }
    return parseOverride(text, "AWH_PRIVATE_CONFIG");
  }
  const path = env.AWH_PRIVATE_CONFIG_PATH;
  if (!path) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`AWH_PRIVATE_CONFIG_PATH could not be read: ${path}`);
  }
  return parseOverride(text, path);
}

function parseOverride(text: string, source: string): Partial<Tuning> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Private config at ${source} is not JSON.`);
  }
  const result = tuningOverrideSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Private config at ${source} does not match the tuning schema.`);
  }
  return result.data;
}
