import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  SourceAttempt,
} from "../types.js";
import {
  createPiAlibabaCredentialBroker,
  type AlibabaCredentialBroker,
  type AlibabaCredentialResolution,
} from "./pi-alibaba-credential.js";
import { piAuthFilePath } from "./pi-auth.js";

export const PI_ALIBABA_CREDENTIAL_SOURCE = "pi:alibaba-plan";
export const ALIBABA_USAGE_CONSOLE_ONLY_REASON =
  "usage is console-only per Alibaba Coding Plan FAQ; no quota API";
export const ALIBABA_MODELS = [
  "Qwen 3.7 Max",
  "Qwen 3.7 Plus",
  "DeepSeek V4 Pro",
  "Kimi K2.6",
  "GLM-5",
  "MiniMax M2.5",
] as const;

const LABEL = "Alibaba Coding Plan";
const PERIOD = "annual";
const REGION = "ap-southeast-1";
const EXPIRING_WITHIN_MS = 5 * 60 * 1_000;

type AlibabaDependencies = {
  broker: AlibabaCredentialBroker;
  now: () => number;
};

export function createAlibabaAdapter(
  overrides: Partial<AlibabaDependencies> = {},
): ProviderAdapter {
  const dependencies: AlibabaDependencies = {
    broker: createPiAlibabaCredentialBroker(),
    now: Date.now,
    ...overrides,
  };

  return {
    id: "alibaba",
    label: LABEL,
    fetchQuota: (options) => fetchQuota(dependencies, options),
    inspectAuth: (options) => inspectAuth(dependencies, options),
  };
}

export const alibabaAdapter = createAlibabaAdapter();

async function fetchQuota(
  dependencies: AlibabaDependencies,
  options: ProviderOptions,
): Promise<ProviderQuota> {
  let resolution: AlibabaCredentialResolution;
  try {
    resolution = await dependencies.broker.resolve({
      refresh: options.refreshCredentials !== false,
    });
  } catch {
    return failedReport("credential_resolution_failed", "error");
  }

  const attempt: SourceAttempt = {
    source: PI_ALIBABA_CREDENTIAL_SOURCE,
    status: resolution.status === "available" ? "success" : "skipped",
    ...(resolution.status !== "available"
      ? { error: credentialError(resolution) }
      : {}),
  };
  if (resolution.status === "available") {
    return entitlementReport(resolution, dependencies.now(), attempt);
  }
  return failedReport(
    credentialError(resolution),
    resolution.status === "error" ? "error" : "auth_required",
    attempt,
    resolution,
  );
}

async function inspectAuth(
  dependencies: AlibabaDependencies,
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  let status: AlibabaCredentialResolution;
  try {
    status = await dependencies.broker.resolve({
      refresh: options.refreshCredentials !== false,
    });
  } catch {
    return {
      provider: "alibaba",
      sources: [
        {
          source: PI_ALIBABA_CREDENTIAL_SOURCE,
          path: piAuthFilePath(),
          status: "invalid",
          error: "credential_resolution_failed",
        },
      ],
    };
  }
  const sourceStatus =
    status.status === "available"
      ? "available"
      : status.status === "expired"
        ? "expired"
        : status.status === "missing"
          ? "missing"
          : "invalid";
  return {
    provider: "alibaba",
    sources: [
      {
        source: PI_ALIBABA_CREDENTIAL_SOURCE,
        path: piAuthFilePath(),
        status: sourceStatus,
        ...(status.status !== "available"
          ? { error: credentialError(status) }
          : {}),
      },
    ],
  };
}

function entitlementReport(
  resolution: Extract<AlibabaCredentialResolution, { status: "available" }>,
  now: number,
  attempt: SourceAttempt,
): ProviderQuota {
  const remainingMilliseconds = Math.max(0, resolution.expiresAtMs - now);
  const expiresAt = iso(resolution.expiresAtMs);
  const refreshedAt = iso(now);
  const credentialStatus =
    remainingMilliseconds <= EXPIRING_WITHIN_MS ? "expiring" : "fresh";
  return {
    provider: "alibaba",
    label: LABEL,
    source: "oauth",
    plan: LABEL,
    period: PERIOD,
    expiresAt,
    region: REGION,
    models: [...ALIBABA_MODELS],
    credential: {
      status: credentialStatus,
      expiresAt,
      remainingSeconds: Math.floor(remainingMilliseconds / 1_000),
    },
    windows: [],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      reason: ALIBABA_USAGE_CONSOLE_ONLY_REASON,
      sourcesTried: [attempt.source],
    },
    attempts: [attempt],
  };
}

function failedReport(
  error: string,
  status: ProviderStatus,
  attempt: SourceAttempt = {
    source: PI_ALIBABA_CREDENTIAL_SOURCE,
    status: "failed",
    error,
  },
  resolution?: Exclude<AlibabaCredentialResolution, { status: "available" }>,
): ProviderQuota {
  const expiresAt =
    resolution?.status === "expired" ? iso(resolution.expiresAtMs) : undefined;
  return {
    provider: "alibaba",
    label: LABEL,
    source: "unavailable",
    plan: LABEL,
    period: PERIOD,
    ...(expiresAt ? { expiresAt } : {}),
    region: REGION,
    models: [...ALIBABA_MODELS],
    ...(expiresAt
      ? {
          credential: {
            status: "expired" as const,
            expiresAt,
            remainingSeconds: 0,
          },
        }
      : {}),
    windows: [],
    state: {
      status,
      stale: false,
      error,
      ...(resolution?.status === "expired"
        ? { reason: "credentials_expired" }
        : {}),
      sourcesTried: [attempt.source],
    },
    attempts: [attempt],
  };
}

function credentialError(
  resolution: Exclude<AlibabaCredentialResolution, { status: "available" }>,
): string {
  switch (resolution.status) {
    case "missing":
      return "alibaba_plan_credential_unavailable";
    case "invalid":
      return "alibaba_plan_credential_invalid";
    case "unsupported":
      return "unsupported_credential_type";
    case "expired":
      return "Alibaba Coding Plan access token expired";
    case "error":
      return "credential_resolution_failed";
  }
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
