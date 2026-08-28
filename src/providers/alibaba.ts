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
const BL_ARGS = ["usage", "token-plan", "--output", "json"];
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

/** Normalize the stable fields emitted by `bl usage token-plan --output json`. */
export function normalizeAlibabaUsage(raw: unknown): NormalizedAlibabaUsage {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const usage = numberValue(root.per1WeekPercentage);
  const windows: QuotaWindow[] = [];
  if (usage !== undefined) {
    const percentUsed = clampPercentage(usage <= 1 ? usage * 100 : usage);
    const percentRemaining = 100 - percentUsed;
    const reset = parseAlibabaReset(root.per1WeekResetTime);
    windows.push({
      id: "weekly",
      label: "week",
      kind: "weekly",
      percentUsed,
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }

  return {
    plan: stringValue(root.planName) ?? stringValue(root.plan) ?? LABEL,
    windows: [...windows, ...normalizeAlibabaModelLimits(root.limits)],
  };
}

function normalizeAlibabaModelLimits(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const windows: QuotaWindow[] = [];
  for (const [index, rawLimit] of value.entries()) {
    const entry = objectValue(rawLimit);
    if (!entry) continue;
    const details =
      objectValue(entry.limit) ??
      objectValue(entry.quota) ??
      objectValue(entry.modelLimit) ??
      objectValue(entry.model_limit);
    const record = details ? { ...entry, ...details } : entry;
    const model = firstString(record, ["model", "modelName", "model_name"]);
    if (!model) continue;

    const remaining = firstNumber(record, [
      "percentRemaining",
      "remainingPercent",
    ]);
    const fraction = firstNumber(record, ["per1WeekPercentage"]);
    const used =
      fraction !== undefined
        ? fraction <= 1
          ? fraction * 100
          : fraction
        : firstNumber(record, [
            "percentUsed",
            "usedPercent",
            "usagePercent",
            "percentage",
            "percent",
          ]);
    const percentRemaining =
      remaining !== undefined
        ? clampPercentage(remaining)
        : used !== undefined
          ? clampPercentage(100 - used)
          : undefined;
    if (percentRemaining === undefined) continue;

    const baseId = `model:${model}`;
    let id = baseId;
    if (ids.has(id)) id = `${baseId}:${index + 1}`;
    ids.add(id);
    const reset = parseAlibabaReset(
      firstValue(record, [
        "resetsAt",
        "resetAt",
        "reset_at",
        "per1WeekResetTime",
        "nextResetTime",
      ]),
    );
    windows.push({
      id,
      label: model,
      kind: "model",
      percentUsed: clampPercentage(100 - percentRemaining),
      percentRemaining,
      ...(reset ? { resetsAt: reset } : {}),
    });
  }
  return windows;
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

function firstString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  return keys.map((key) => stringValue(value[key])).find(Boolean);
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

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(
  value: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseAlibabaReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(
      value > 100_000_000_000 ? value : value * 1000,
    ).toISOString();
  }
  return parseEpochOrIso(value);
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
