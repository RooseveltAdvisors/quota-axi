import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { parseEpochOrIso, clampPercent } from "../lib/time.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const ALIBABA_QUOTA_URL =
  "https://dashscope-intl.aliyuncs.com/api/v1/models/limits";
export const ALIBABA_CREDENTIAL_SOURCE = "pi:alibaba-plan";

const LABEL = "Alibaba Coding Plan";
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS = 18_000;
const WEEK = 7 * 24 * 60 * 60;
const DEADLINE_MS = 15_000;

type CredentialResolution =
  | { status: "available"; key: string; path: string }
  | { status: "missing" | "invalid" | "error"; path: string };

type Dependencies = {
  credential: () => CredentialResolution;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

export type NormalizedAlibabaPayload = {
  plan?: string;
  windows: QuotaWindow[];
};

export function piAlibabaAuthFilePath(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  const directory = configured
    ? configured === "~"
      ? homedir()
      : configured.startsWith("~/")
        ? join(homedir(), configured.slice(2))
        : configured
    : join(homedir(), ".pi", "agent");
  return join(directory, "auth.json");
}

export function extractAlibabaCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  const entry = objectValue(root?.["alibaba-plan"]);
  if (!entry) return { status: "missing", path };
  const key = [
    entry.access,
    entry.key,
    entry.apiKey,
    entry.api_key,
    entry.token,
  ]
    .map(usableLiteralSecret)
    .find((candidate): candidate is string => candidate !== undefined);
  return key ? { status: "available", key, path } : { status: "invalid", path };
}

export function resolveAlibabaCredential(
  path = piAlibabaAuthFilePath(),
): CredentialResolution {
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing") return { status: "missing", path };
  if (result.status === "invalid") {
    return {
      status: result.error === "file_read_error" ? "error" : "invalid",
      path,
    };
  }
  return extractAlibabaCredential(result.value, path);
}

export function createAlibabaAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveAlibabaCredential(),
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "alibaba",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const alibabaAdapter = createAlibabaAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const resolution = dependencies.credential();
  const attempts: SourceAttempt[] = [
    {
      source: ALIBABA_CREDENTIAL_SOURCE,
      status: resolution.status === "available" ? "failed" : "skipped",
      ...(resolution.status !== "available"
        ? { error: credentialError(resolution) }
        : {}),
    },
  ];
  if (resolution.status !== "available") {
    return failedProvider({
      provider: "alibaba",
      label: LABEL,
      status: resolution.status === "missing" ? "auth_required" : "error",
      error: credentialError(resolution),
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  try {
    const payload = await requestQuota(
      resolution.key,
      dependencies.fetch,
      dependencies.now,
      dependencies.deadlineMs,
    );
    const normalized = normalizeAlibabaPayload(payload);
    if (normalized.windows.length === 0) throw new Error("quota_missing");
    attempts[0] = { source: ALIBABA_CREDENTIAL_SOURCE, status: "success" };
    return successProvider({
      provider: "alibaba",
      label: LABEL,
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const code = errorCode(error);
    attempts[0] = {
      source: ALIBABA_CREDENTIAL_SOURCE,
      status: "failed",
      error: code,
    };
    return failedProvider({
      provider: "alibaba",
      label: LABEL,
      status:
        code === "provider_auth_rejected"
          ? "auth_required"
          : code === "provider_rate_limited"
            ? "rate_limited"
            : "error",
      error: code,
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const resolution = dependencies.credential();
  const source: AuthSourceReport = {
    source: ALIBABA_CREDENTIAL_SOURCE,
    path: resolution.path,
    status:
      resolution.status === "available"
        ? "available"
        : resolution.status === "missing"
          ? "missing"
          : "invalid",
    ...(resolution.status === "error"
      ? { error: "credential_resolution_failed" }
      : {}),
  };
  return { provider: "alibaba", sources: [source] };
}

async function requestQuota(
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  now: () => number,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetchImplementation(ALIBABA_QUOTA_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
        },
        credentials: "omit",
        redirect: "manual",
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("provider_timeout")),
          deadlineMs,
        );
      }),
    ]);
    if (response.status === 401 || response.status === 403)
      throw new Error("provider_auth_rejected");
    if (response.status === 429) throw new Error("provider_rate_limited");
    if (!response.ok) throw new Error("provider_request_rejected");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length > RESPONSE_LIMIT_BYTES)
      throw new Error("response_too_large");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("malformed_json");
    }
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("provider_timeout", { cause: error });
    if (error instanceof Error && error.message.startsWith("provider_"))
      throw error;
    throw new Error("network_unavailable", { cause: error });
  } finally {
    clearTimeout(timer);
    if (timeout) clearTimeout(timeout);
  }
}

export function normalizeAlibabaPayload(
  raw: unknown,
): NormalizedAlibabaPayload {
  const root = objectValue(raw);
  if (!root) return { windows: [] };
  const data = objectValue(root.data) ?? root;
  const plan =
    firstString(root, ["planName", "plan_name", "plan"]) ??
    firstString(data, ["planName", "plan_name", "plan"]);
  const windows = normalizeKnownWindows(root, data);
  return { ...(plan ? { plan } : {}), windows };
}

function normalizeKnownWindows(
  root: Record<string, unknown>,
  data: Record<string, unknown>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  const usage = objectValue(root.usage) ?? objectValue(data.usage) ?? data;
  const definitions = [
    [
      "five_hour",
      "session",
      "session",
      FIVE_HOURS,
      ["fiveHour", "five_hour", "rolling"],
    ],
    [
      "weekly",
      "week",
      "weekly",
      WEEK,
      ["weekly", "week", "sevenDay", "seven_day"],
    ],
    ["monthly", "month", "monthly", undefined, ["monthly", "month"]],
  ] as const;
  for (const [id, label, kind, seconds, names] of definitions) {
    const record = names.map((name) => objectValue(usage[name])).find(Boolean);
    const window = record
      ? normalizeWindow(record, id, label, kind, seconds)
      : undefined;
    if (window) windows.push(window);
  }

  if (windows.length > 0) return windows;
  const legacy =
    objectValue(root.codingPlanQuotaInfo) ??
    objectValue(data.codingPlanQuotaInfo) ??
    objectValue(data.coding_plan_quota_info);
  if (legacy) {
    const legacyDefinitions = [
      [
        "five_hour",
        "session",
        "session",
        FIVE_HOURS,
        ["per5HourUsedQuota", "perFiveHourUsedQuota"],
        ["per5HourTotalQuota", "perFiveHourTotalQuota"],
        ["per5HourQuotaNextRefreshTime", "perFiveHourQuotaNextRefreshTime"],
      ],
      [
        "weekly",
        "week",
        "weekly",
        WEEK,
        ["perWeekUsedQuota"],
        ["perWeekTotalQuota"],
        ["perWeekQuotaNextRefreshTime"],
      ],
      [
        "monthly",
        "month",
        "monthly",
        undefined,
        ["perBillMonthUsedQuota", "perMonthUsedQuota"],
        ["perBillMonthTotalQuota", "perMonthTotalQuota"],
        ["perBillMonthQuotaNextRefreshTime", "perMonthQuotaNextRefreshTime"],
      ],
    ] as const;
    for (const [
      id,
      label,
      kind,
      seconds,
      usedKeys,
      limitKeys,
      resetKeys,
    ] of legacyDefinitions) {
      const used = firstNumber(legacy, usedKeys);
      const limit = firstNumber(legacy, limitKeys);
      if (used === undefined || limit === undefined || limit <= 0) continue;
      const window = normalizeWindow(
        {
          used,
          limit,
          ...(firstValue(legacy, resetKeys) !== undefined
            ? { resetAt: firstValue(legacy, resetKeys) }
            : {}),
        },
        id,
        label,
        kind,
        seconds,
      );
      if (window) windows.push(window);
    }
  }
  if (windows.length > 0) return windows;
  const output = objectValue(root.output) ?? objectValue(data.output);
  const quotas = output?.quotas ?? data.quotas ?? root.quotas;
  if (!Array.isArray(quotas)) return windows;
  for (const [index, value] of quotas.entries()) {
    const entry = objectValue(value);
    const limit =
      objectValue(entry?.workspace_limit) ?? objectValue(entry?.model_limit);
    if (!entry || !limit) continue;
    const period = numberValue(limit.usage_limit_period);
    const model = stringValue(entry.model);
    const window = normalizeWindow(
      { ...entry, ...limit },
      period === WEEK
        ? `model:${model ?? index}:weekly`
        : `model:${model ?? index}`,
      period === WEEK
        ? (model ?? `model ${index + 1}`)
        : (model ?? `model ${index + 1}`),
      "model",
      period === WEEK ? WEEK : undefined,
    );
    if (window) windows.push(window);
  }
  return windows;
}

function normalizeWindow(
  record: Record<string, unknown>,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  windowSeconds: number | undefined,
): QuotaWindow | undefined {
  const directRemaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const directUsed = firstNumber(record, [
    "percentUsed",
    "usedPercent",
    "percentage",
    "percent",
  ]);
  const used = firstNumber(record, [
    "used",
    "usage",
    "currentUsage",
    "consumed",
    "usedQuota",
  ]);
  const limit = firstNumber(record, [
    "limit",
    "total",
    "usage_limit",
    "totalQuota",
  ]);
  const percentRemaining =
    directRemaining !== undefined
      ? clampPercent(directRemaining)
      : directUsed !== undefined
        ? clampPercent(100 - directUsed)
        : used !== undefined && limit !== undefined && limit > 0
          ? clampPercent(100 - (used / limit) * 100)
          : undefined;
  if (percentRemaining === undefined) return undefined;
  const reset = firstValue(record, [
    "resetsAt",
    "resetAt",
    "reset_at",
    "nextResetTime",
    "next_reset_time",
    "perWeekQuotaNextRefreshTime",
    "per5HourQuotaNextRefreshTime",
  ]);
  return {
    id,
    label,
    kind,
    percentRemaining,
    percentUsed: clampPercent(100 - percentRemaining),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(parseEpochOrIso(reset) ? { resetsAt: parseEpochOrIso(reset) } : {}),
  };
}

function credentialError(
  resolution: Exclude<CredentialResolution, { status: "available" }>,
): string {
  return resolution.status === "missing"
    ? "alibaba_credential_unavailable"
    : resolution.status === "invalid"
      ? "alibaba_credential_invalid"
      : "credential_resolution_failed";
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "quota_request_failed";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return keys.map((key) => stringValue(value[key])).find(Boolean);
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
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
