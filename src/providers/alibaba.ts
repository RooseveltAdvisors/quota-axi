import { execFileText } from "../lib/process.js";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { parseEpochOrIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
} from "./common.js";

const BL_COMMAND = "bl";
const BL_SOURCE = "bl-cli";
const BL_ARGS = ["usage", "summary", "--days", "1", "--output", "json"];
const BL_TIMEOUT_MS = 15_000;
const LABEL = "Alibaba Coding Plan";

type AlibabaDependencies = {
  commandExists: (command: string) => Promise<boolean>;
  execFileText: typeof execFileText;
  now: () => number;
};

export type NormalizedAlibabaUsage = {
  plan?: string;
  windows: QuotaWindow[];
};

export function createAlibabaAdapter(
  overrides: Partial<AlibabaDependencies> = {},
): ProviderAdapter {
  const dependencies: AlibabaDependencies = {
    commandExists: commandOnPath,
    execFileText,
    now: Date.now,
    ...overrides,
  };

  return {
    id: "alibaba",
    label: LABEL,
    fetchQuota: (_options: ProviderOptions) =>
      fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options: ProviderOptions) =>
      inspectAuthWithDependencies(dependencies),
  };
}

export const alibabaAdapter = createAlibabaAdapter();

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithDependencies({
    commandExists: commandOnPath,
    execFileText,
    now: Date.now,
  });
}

async function fetchQuotaWithDependencies(
  dependencies: AlibabaDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [{ source: BL_SOURCE, status: "failed" }];

  try {
    if (!(await dependencies.commandExists(BL_COMMAND))) {
      attempts[0] = {
        source: BL_SOURCE,
        status: "skipped",
        error: "bl_cli_unavailable",
      };
      return failedProvider({
        provider: "alibaba",
        label: LABEL,
        status: "unavailable",
        error: "bl_cli_unavailable",
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }

    const output = await dependencies.execFileText(
      BL_COMMAND,
      BL_ARGS,
      BL_TIMEOUT_MS,
    );
    const normalized = normalizeAlibabaUsage(JSON.parse(output));
    if (normalized.windows.length === 0) {
      throw new Error("bl_usage_data_unavailable");
    }

    attempts[0] = { source: BL_SOURCE, status: "success" };
    return successProvider({
      provider: "alibaba",
      label: LABEL,
      source: "cli",
      plan: normalized.plan,
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[0] = { source: BL_SOURCE, status: "failed", error: message };
    return failedProvider({
      provider: "alibaba",
      label: LABEL,
      status: statusFromError(message),
      error: message,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuthWithDependencies(
  dependencies: AlibabaDependencies,
): Promise<AuthProviderReport> {
  let source: AuthSourceReport;
  try {
    source = (await dependencies.commandExists(BL_COMMAND))
      ? { source: BL_SOURCE, status: "available" }
      : { source: BL_SOURCE, status: "missing" };
  } catch (error) {
    source = {
      source: BL_SOURCE,
      status: "error",
      error: errorMessage(error),
    };
  }
  return { provider: "alibaba", sources: [source] };
}

/** Normalize the stable fields emitted by `bl usage summary --output json`. */
export function normalizeAlibabaUsage(raw: unknown): NormalizedAlibabaUsage {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const data = objectValue(root.data) ?? root;
  const entries = firstArray(data, ["freeTier", "free_tier", "quotas"]);
  const windows = (entries ?? [])
    .map((entry, index) => normalizeWindow(entry, index))
    .filter((window): window is QuotaWindow => window !== undefined);

  return {
    plan:
      stringValue(root.planName) ??
      stringValue(root.plan_name) ??
      stringValue(root.plan) ??
      stringValue(data.planName) ??
      stringValue(data.plan_name) ??
      stringValue(data.plan) ??
      LABEL,
    windows,
  };
}

function normalizeWindow(
  value: unknown,
  index: number,
): QuotaWindow | undefined {
  const entry = objectValue(value);
  if (!entry) return undefined;

  const remaining =
    numberValue(entry.remainingPercent) ??
    numberValue(entry.remaining_percent) ??
    ratioAsPercent(entry.remaining, entry.total);
  if (remaining === undefined) return undefined;

  const model =
    stringValue(entry.model) ??
    stringValue(entry.modelName) ??
    stringValue(entry.model_name);
  const id = model ? `model:${model}` : `free_tier:${index}`;
  const reset = parseEpochOrIso(
    entry.resetsAt ??
      entry.resetAt ??
      entry.reset_at ??
      entry.nextResetTime ??
      entry.next_reset_time ??
      entry.expires,
  );

  return {
    id,
    label: model ?? `Free tier ${index + 1}`,
    kind: model ? "model" : "unknown",
    percentUsed: 100 - clampPercent(remaining),
    percentRemaining: clampPercent(remaining),
    ...(reset ? { resetsAt: reset } : {}),
  };
}

function firstArray(
  value: Record<string, unknown>,
  keys: string[],
): unknown[] | undefined {
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  return undefined;
}

async function commandOnPath(command: string): Promise<boolean> {
  const pathValue = process.env.PATH;
  if (!pathValue || command.includes("/") || command.includes("\\")) {
    return false;
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    const candidate = path.join(directory || ".", command);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry; execFile reports any eventual launch error.
    }
  }
  return false;
}

function ratioAsPercent(
  remaining: unknown,
  total: unknown,
): number | undefined {
  const remainingValue = numberValue(remaining);
  const totalValue = numberValue(total);
  if (
    remainingValue === undefined ||
    totalValue === undefined ||
    totalValue <= 0
  ) {
    return undefined;
  }
  return (remainingValue / totalValue) * 100;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function errorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "bl_usage_malformed_json";
  if (error instanceof Error) {
    const message = error.message.trim();
    return message
      ? `bl_usage_failed: ${message.slice(0, 240)}`
      : "bl_usage_failed";
  }
  return "bl_usage_failed";
}
