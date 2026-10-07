import { readFileSync } from "node:fs";
import path from "node:path";

export type FactoryConfig = {
  github: { host: string; owner: string; repo: string } | null;
  keys: Record<string, { provider: "github" }>;
  limits: { infrastructureRetries: number; planCorrections: number; };
  models: { plan: string; review: string; work: string; };
};

export type ConfigResult = { config: FactoryConfig; kind: "ok"; } | { kind: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readLimit(record: Record<string, unknown>, key: string, fallback: number): number | null {
  if (!(key in record)) {return fallback;}
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {return null;}
  return value;
}

export function parseFactoryConfig(value: unknown): ConfigResult {
  if (!isRecord(value)) {return { kind: "error", message: "FACTORY.json must be an object." };}
  const modelsValue = value["models"];
  if (!isRecord(modelsValue)) {
    return { kind: "error", message: "FACTORY.json needs models.work and models.review." };
  }
  const work = readString(modelsValue, "work");
  const review = readString(modelsValue, "review");
  const plan = readString(modelsValue, "plan") ?? work;
  if (work === null || review === null || plan === null) {
    return { kind: "error", message: "FACTORY.json needs models.work and models.review." };
  }
  if (work === review) {
    return { kind: "error", message: "models.review must be different from models.work." };
  }

  const limitsValue = value["limits"];
  let planCorrections = 3;
  let infrastructureRetries = 3;
  if (limitsValue !== undefined) {
    if (!isRecord(limitsValue)) {return { kind: "error", message: "FACTORY.json limits must be an object." };}
    const corrections = readLimit(limitsValue, "planCorrections", 3);
    const retries = readLimit(limitsValue, "infrastructureRetries", 3);
    if (corrections === null || retries === null) {
      return { kind: "error", message: "FACTORY.json limits must be non-negative integers." };
    }
    planCorrections = corrections;
    infrastructureRetries = retries;
  }

  let github: FactoryConfig["github"] = null;
  if (value["github"] !== undefined) {
    const githubValue = value["github"];
    if (!isRecord(githubValue)) {return { kind: "error", message: "FACTORY.json github must be an object." };}
    const owner = readString(githubValue, "owner");
    const repo = readString(githubValue, "repo");
    const host = readString(githubValue, "host") ?? "github.com";
    if (owner === null || repo === null) {
      return { kind: "error", message: "FACTORY.json github needs owner and repo." };
    }
    github = { host, owner, repo };
  }

  const keys: FactoryConfig["keys"] = {};
  if (value["keys"] !== undefined) {
    const keysValue = value["keys"];
    if (!isRecord(keysValue)) {return { kind: "error", message: "FACTORY.json keys must be an object." };}
    for (const [name, spec] of Object.entries(keysValue)) {
      if (!isRecord(spec) || spec["provider"] !== "github") {
        return { kind: "error", message: `FACTORY.json key ${name} must set provider to github.` };
      }
      keys[name] = { provider: "github" };
    }
  }

  return {
    config: { github, keys, limits: { infrastructureRetries, planCorrections }, models: { plan, review, work } },
    kind: "ok",
  };
}

export function readFactoryConfig(factoryRoot: string): ConfigResult {
  const file = path.join(factoryRoot, "FACTORY.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { kind: "error", message: `Missing ${file}. Create FACTORY.json with models.work and models.review before /factory start.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "error", message: `${file} is not valid JSON.` };
  }
  return parseFactoryConfig(parsed);
}
