import { homedir } from "node:os";
import { join } from "node:path";
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
import { failedProvider, sourceNames, successProvider } from "./common.js";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
export const OPENCODE_GO_CREDENTIAL_SOURCE = "opencode:auth.json";

const LABEL = "OpenCode Go";
const RESPONSE_LIMIT_BYTES = 262_144;
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

export type NormalizedOpenCodeGoPayload = {
  plan?: string;
  windows: QuotaWindow[];
};

export function opencodeGoAuthFilePath(): string {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  return join(
    xdg || join(homedir(), ".local", "share"),
    "opencode",
    "auth.json",
  );
}

export function extractOpenCodeGoCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const root = objectValue(value);
  const entry =
    objectValue(root?.["opencode-go"]) ?? objectValue(root?.opencode);
  if (!entry) return { status: "missing", path };
  const key = [
    entry.key,
    entry.apiKey,
    entry.api_key,
    entry.access,
    entry.token,
  ]
    .map(usableLiteralSecret)
    .find((candidate): candidate is string => candidate !== undefined);
  return key ? { status: "available", key, path } : { status: "invalid", path };
}

export function resolveOpenCodeGoCredential(
  path = opencodeGoAuthFilePath(),
): CredentialResolution {
  const result: JsonFileReadResult = readJsonFileResult(path);
  if (result.status === "missing") return { status: "missing", path };
  if (result.status === "invalid") {
    return {
      status: result.error === "file_read_error" ? "error" : "invalid",
      path,
    };
  }
  return extractOpenCodeGoCredential(result.value, path);
}

export function createOpenCodeGoAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveOpenCodeGoCredential(),
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "opencode-go",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const opencodeGoAdapter = createOpenCodeGoAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const resolution = dependencies.credential();
  const attempts: SourceAttempt[] = [
    {
      source: OPENCODE_GO_CREDENTIAL_SOURCE,
      status: resolution.status === "available" ? "failed" : "skipped",
      ...(resolution.status !== "available"
        ? { error: credentialError(resolution) }
        : {}),
    },
  ];
  if (resolution.status !== "available") {
    return failedProvider({
      provider: "opencode-go",
      label: LABEL,
      status: resolution.status === "missing" ? "auth_required" : "error",
      error: credentialError(resolution),
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  try {
    const payload = await requestUsage(
      resolution.key,
      dependencies.fetch,
      dependencies.deadlineMs,
    );
    const normalized = normalizeOpenCodeGoPayload(payload);
    if (normalized.windows.length === 0) throw new Error("quota_missing");
    attempts[0] = { source: OPENCODE_GO_CREDENTIAL_SOURCE, status: "success" };
    return successProvider({
      provider: "opencode-go",
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
      source: OPENCODE_GO_CREDENTIAL_SOURCE,
      status: "failed",
      error: code,
    };
    return failedProvider({
      provider: "opencode-go",
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
    source: OPENCODE_GO_CREDENTIAL_SOURCE,
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
  return { provider: "opencode-go", sources: [source] };
}

async function requestUsage(
  key: string,
  fetchImplementation: typeof globalThis.fetch,
  deadlineMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetchImplementation(OPENCODE_GO_USAGE_URL, {
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

export function normalizeOpenCodeGoPayload(
  raw: unknown,
): NormalizedOpenCodeGoPayload {
  const root = objectValue(raw);
  const usage = objectValue(root?.usage);
  if (!usage) return { windows: [] };
  const definitions = [
    ["rolling", "five_hour", "session"],
    ["weekly", "weekly", "weekly"],
    ["monthly", "monthly", "monthly"],
  ] as const;
  const windows = definitions
    .map(([name, id, kind]) => {
      const record = objectValue(usage[name]);
      return record ? normalizeWindow(record, id, kind) : undefined;
    })
    .filter((window): window is QuotaWindow => window !== undefined);
  const plan =
    firstString(root, ["planName", "plan_name", "plan"]) ?? "OpenCode Go";
  return { plan, windows };
}

function normalizeWindow(
  record: Record<string, unknown>,
  id: string,
  kind: QuotaWindow["kind"],
): QuotaWindow | undefined {
  const used = firstNumber(record, ["percent", "percentUsed", "usedPercent"]);
  const remaining = firstNumber(record, [
    "percentRemaining",
    "remainingPercent",
  ]);
  const percentRemaining =
    remaining !== undefined
      ? clampPercent(remaining)
      : used !== undefined
        ? clampPercent(100 - used)
        : undefined;
  if (percentRemaining === undefined) return undefined;
  const reset = firstValue(record, [
    "resetsAt",
    "resetAt",
    "reset_at",
    "nextResetTime",
  ]);
  const windowSeconds = firstNumber(record, [
    "windowSeconds",
    "window_seconds",
    "cycleSeconds",
    "cycle_seconds",
    "durationSeconds",
    "duration_seconds",
    "periodSeconds",
    "period_seconds",
  ]);
  return {
    id,
    label: id === "five_hour" ? "session" : id,
    kind,
    percentUsed: clampPercent(100 - percentRemaining),
    percentRemaining,
    ...(windowSeconds !== undefined && windowSeconds > 0
      ? { windowSeconds }
      : {}),
    ...(parseEpochOrIso(reset) ? { resetsAt: parseEpochOrIso(reset) } : {}),
  };
}

function credentialError(
  resolution: Exclude<CredentialResolution, { status: "available" }>,
): string {
  return resolution.status === "missing"
    ? "opencode_go_credential_unavailable"
    : resolution.status === "invalid"
      ? "opencode_go_credential_invalid"
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
  value: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  return value
    ? keys.map((key) => stringValue(value[key])).find(Boolean)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: string[],
): number | undefined {
  return keys
    .map((key) => numberValue(value[key]))
    .find((item) => item !== undefined);
}

function firstValue(value: Record<string, unknown>, keys: string[]): unknown {
  return keys
    .map((key) => value[key])
    .find((item) => item !== undefined && item !== null);
}
