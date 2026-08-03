import { randomUUID } from "node:crypto";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { clampPercent } from "../lib/time.js";
import {
  createPiAlibabaCredentialBroker,
  type AlibabaCredentialBroker,
  type AlibabaCredentialResolution,
} from "./pi-alibaba-credential.js";
import { piAuthFilePath } from "./pi-auth.js";

export const PI_ALIBABA_CREDENTIAL_SOURCE = "pi:alibaba-plan";
export const ALIBABA_COOKIE_SOURCE = "cookie:alibaba-coding-plan";
export const ALIBABA_API_KEY_SOURCE = "env:alibaba-api-key";
export const ALIBABA_USAGE_CONSOLE_ONLY_REASON =
  "usage windows unavailable from the configured Alibaba Coding Plan source";
export const ALIBABA_MODELS = [
  "qwen3.8-max",
  "qwen3.8-max-preview",
  "qwen3.7-plus",
  "qwen3.7-max",
  "qwen3.6-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-0731",
  "glm-5.2",
] as const;
export const ALIBABA_MODEL_LABELS: Readonly<Record<string, string>> = {
  "qwen3.8-max": "Limited-time Night 50% Off; text/reasoning/visual",
  "qwen3.8-max-preview":
    "Limited-time 10x Boost and Night 20% Off; text/reasoning/visual",
};

const LABEL = "Alibaba Coding Plan";
const DEFAULT_PERIOD = "annual";
const DEFAULT_REGION = "ap-southeast-1";
const OPERATION_DEADLINE_MS = 15_000;
const RESPONSE_LIMIT_BYTES = 262_144;
const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
const QUOTA_FIELD_ALIASES = {
  fiveHour: {
    used: ["per5HourUsedQuota", "perFiveHourUsedQuota"],
    limit: ["per5HourTotalQuota", "perFiveHourTotalQuota"],
    reset: [
      "per5HourQuotaNextRefreshTime",
      "perFiveHourQuotaNextRefreshTime",
    ],
  },
  weekly: {
    used: ["perWeekUsedQuota"],
    limit: ["perWeekTotalQuota"],
    reset: ["perWeekQuotaNextRefreshTime"],
  },
  monthly: {
    used: ["perBillMonthUsedQuota", "perMonthUsedQuota"],
    limit: ["perBillMonthTotalQuota", "perMonthTotalQuota"],
    reset: [
      "perBillMonthQuotaNextRefreshTime",
      "perMonthQuotaNextRefreshTime",
    ],
  },
} as const;
const QUOTA_DISCOVERY_FIELDS = Object.values(QUOTA_FIELD_ALIASES).flatMap(
  ({ used, limit }) => [...used, ...limit],
);
const INSTANCE_INFO_KEYS = [
  "codingPlanInstanceInfos",
  "coding_plan_instance_infos",
] as const;
const QUOTA_INFO_KEYS = [
  "codingPlanQuotaInfo",
  "coding_plan_quota_info",
] as const;
const COOKIE_LIMIT_CHARS = 128 * 1024;
const DASHBOARD_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan";
const CONSOLE_REFERER_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan";
const INTERNATIONAL_GATEWAY_URL =
  "https://modelstudio.console.alibabacloud.com";
const INTERNATIONAL_API_URL =
  "https://modelstudio.console.alibabacloud.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=ap-southeast-1";
const INTERNATIONAL_CONSOLE_RPC_URL =
  "https://bailian-singapore-cs.alibabacloud.com/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&_v=undefined";
const CHINA_API_URL =
  "https://bailian.console.aliyun.com/data/api.json?action=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&product=broadscope-bailian&api=queryCodingPlanInstanceInfoV2&currentRegionId=cn-beijing";
const CHINA_DASHBOARD_URL =
  "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan";
const CHINA_CONSOLE_REFERER_URL =
  "https://bailian.console.aliyun.com/cn-beijing/?tab=model";
const CHINA_GATEWAY_URL = "https://bailian.console.aliyun.com";
const CHINA_CONSOLE_RPC_URL =
  "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&_v=undefined";

type AlibabaEnvironment = Readonly<Record<string, string | undefined>>;
type AlibabaAuthMode = "console" | "api-key";

type AlibabaDependencies = {
  broker: AlibabaCredentialBroker;
  environment: AlibabaEnvironment;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
  responseLimitBytes: number;
};

type AlibabaRegion = "international" | "china-mainland";

type RegionConfig = {
  id: AlibabaRegion;
  currentRegionId: string;
  apiURL: string;
  consoleRPCURL: string;
  dashboardURL: string;
  consoleRefererURL: string;
  gatewayURL: string;
  originURL: string;
  consoleDomain: string;
  consoleSite: string;
  commodityCode: string;
};

const REGIONS: Record<AlibabaRegion, RegionConfig> = {
  international: {
    id: "international",
    currentRegionId: DEFAULT_REGION,
    apiURL: INTERNATIONAL_API_URL,
    consoleRPCURL: INTERNATIONAL_CONSOLE_RPC_URL,
    dashboardURL: DASHBOARD_URL,
    consoleRefererURL: CONSOLE_REFERER_URL,
    gatewayURL: INTERNATIONAL_GATEWAY_URL,
    originURL: INTERNATIONAL_GATEWAY_URL,
    consoleDomain: "modelstudio.console.alibabacloud.com",
    consoleSite: "MODELSTUDIO_ALIBABACLOUD",
    commodityCode: "sfm_codingplan_public_intl",
  },
  "china-mainland": {
    id: "china-mainland",
    currentRegionId: "cn-beijing",
    apiURL: CHINA_API_URL,
    consoleRPCURL: CHINA_CONSOLE_RPC_URL,
    dashboardURL: CHINA_DASHBOARD_URL,
    consoleRefererURL: CHINA_CONSOLE_REFERER_URL,
    gatewayURL: CHINA_GATEWAY_URL,
    originURL: CHINA_GATEWAY_URL,
    consoleDomain: "bailian.console.aliyun.com",
    consoleSite: "BAILIAN_ALIYUN",
    commodityCode: "sfm_codingplan_public_cn",
  },
};

type AlibabaCandidate =
  | { kind: "cookie"; value: string; source: typeof ALIBABA_COOKIE_SOURCE }
  | {
      kind: "api-key";
      value: string;
      source:
        | typeof PI_ALIBABA_CREDENTIAL_SOURCE
        | typeof ALIBABA_API_KEY_SOURCE;
      credential?: Extract<
        AlibabaCredentialResolution,
        { status: "available" }
      >;
    };

type NormalizedAlibabaUsage = {
  plan?: string;
  period?: string;
  instance?: ProviderQuota["instance"];
  models?: string[];
  multiplier?: number;
  modelMultipliers?: Record<string, number>;
  modelLabels?: Record<string, string>;
  windows: QuotaWindow[];
};

type ResponseData = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

class AlibabaUsageError extends Error {
  readonly code: string;
  readonly retryInChina: boolean;

  constructor(code: string, retryInChina = false) {
    super(code);
    this.name = "AlibabaUsageError";
    this.code = code;
    this.retryInChina = retryInChina;
  }
}

export function createAlibabaAdapter(
  overrides: Partial<AlibabaDependencies> = {},
): ProviderAdapter {
  const dependencies: AlibabaDependencies = {
    broker: createPiAlibabaCredentialBroker(),
    environment: process.env,
    fetch: globalThis.fetch,
    now: Date.now,
    deadlineMs: OPERATION_DEADLINE_MS,
    responseLimitBytes: RESPONSE_LIMIT_BYTES,
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
  const resolution = await resolvePiCredential(dependencies, options);
  const cookie = configuredCookie(dependencies.environment);
  const apiKey = configuredApiKey(dependencies.environment);
  const candidates: AlibabaCandidate[] = [];

  if (cookie) {
    candidates.push({
      kind: "cookie",
      value: cookie,
      source: ALIBABA_COOKIE_SOURCE,
    });
  }
  if (resolution.status === "available") {
    candidates.push({
      kind: "api-key",
      value: resolution.accessToken,
      source: PI_ALIBABA_CREDENTIAL_SOURCE,
      credential: resolution,
    });
  }
  if (apiKey) {
    candidates.push({
      kind: "api-key",
      value: apiKey,
      source: ALIBABA_API_KEY_SOURCE,
    });
  }

  const attempts: SourceAttempt[] = [];
  if (candidates.length === 0) {
    attempts.push({
      source: PI_ALIBABA_CREDENTIAL_SOURCE,
      status: "skipped",
      error: credentialError(resolution),
    });
    return failedReport(
      resolution.status === "available"
        ? "alibaba_usage_source_unavailable"
        : credentialError(resolution),
      resolution.status === "error" ? "error" : "auth_required",
      attempts,
      resolution,
      dependencies.environment,
    );
  }

  let lastError = "alibaba_usage_unavailable";
  const operationController = new AbortController();
  const operationTimer = setTimeout(
    () => operationController.abort(),
    dependencies.deadlineMs,
  );
  try {
    for (const candidate of candidates) {
      if (operationController.signal.aborted) {
        lastError = "alibaba_quota_timeout";
        break;
      }
      attempts.push({ source: candidate.source, status: "failed" });
      try {
        const region = configuredRegion(dependencies.environment);
        const result = await fetchCandidateUsageAcrossRegions(
          candidate,
          region,
          dependencies,
          operationController.signal,
        );
        attempts[attempts.length - 1] = {
          source: candidate.source,
          status: "success",
        };
        return usageReport(
          candidate,
          result.usage,
          result.region,
          dependencies.now(),
          attempts,
        );
      } catch (error) {
        lastError = safeAlibabaError(error);
        attempts[attempts.length - 1] = {
          source: candidate.source,
          status: "failed",
          error: lastError,
        };
        if (operationController.signal.aborted) break;
      }
    }
  } finally {
    clearTimeout(operationTimer);
  }

  return failedReport(
    lastError,
    providerStatusFor(lastError),
    attempts,
    resolution,
    dependencies.environment,
  );
}

async function inspectAuth(
  dependencies: AlibabaDependencies,
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const resolution = await resolvePiCredential(dependencies, options);
  const sources: AuthSourceReport[] = [];
  const cookie = configuredCookie(dependencies.environment);
  const apiKey = configuredApiKey(dependencies.environment);

  sources.push({
    source: ALIBABA_COOKIE_SOURCE,
    status: cookie ? "available" : "missing",
    ...(cookie ? {} : { error: "alibaba_cookie_unavailable" }),
  });
  sources.push({
    source: PI_ALIBABA_CREDENTIAL_SOURCE,
    path: piAuthFilePath(),
    status: piAuthStatus(resolution),
    ...(resolution.status !== "available"
      ? { error: credentialError(resolution) }
      : {}),
  });
  if (apiKey) {
    sources.push({ source: ALIBABA_API_KEY_SOURCE, status: "available" });
  }
  return { provider: "alibaba", sources };
}

async function resolvePiCredential(
  dependencies: AlibabaDependencies,
  options: ProviderOptions,
): Promise<AlibabaCredentialResolution> {
  try {
    return await dependencies.broker.resolve({
      refresh: options.refreshCredentials !== false,
      fetch: dependencies.fetch,
    });
  } catch {
    return { status: "error" };
  }
}

async function fetchCandidateUsage(
  candidate: AlibabaCandidate,
  region: RegionConfig,
  dependencies: AlibabaDependencies,
  signal: AbortSignal,
): Promise<NormalizedAlibabaUsage> {
  throwIfAborted(signal);
  if (candidate.kind === "cookie") {
    const secToken = await resolveSecToken(
      candidate.value,
      region,
      dependencies,
      signal,
    );
    const response = await requestResponse(
      region.consoleRPCURL,
      {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: candidate.value,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 quota-axi",
          Origin: region.originURL,
          Referer: region.consoleRefererURL,
          ...csrfHeaders(candidate.value),
        },
        body: consoleRequestBody(
          region,
          secToken,
          cookieValue("cna", candidate.value),
        ),
        signal,
      },
      dependencies,
      true,
    );
    return parseUsageResponse(
      response,
      "console",
      dependencies.now(),
      region.id === "international",
    );
  }

  const response = await requestResponse(
    region.apiURL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${candidate.value}`,
        "x-api-key": candidate.value,
        "X-DashScope-API-Key": candidate.value,
        "User-Agent": "quota-axi",
        Origin: region.originURL,
        Referer: region.dashboardURL,
      },
      body: JSON.stringify({
        queryCodingPlanInstanceInfoRequest: {
          commodityCode: region.commodityCode,
        },
      }),
      signal,
    },
    dependencies,
    true,
  );
  return parseUsageResponse(
    response,
    "api-key",
    dependencies.now(),
    region.id === "international",
  );
}

async function fetchCandidateUsageAcrossRegions(
  candidate: AlibabaCandidate,
  region: RegionConfig,
  dependencies: AlibabaDependencies,
  signal: AbortSignal,
): Promise<{ usage: NormalizedAlibabaUsage; region: RegionConfig }> {
  try {
    return {
      usage: await fetchCandidateUsage(candidate, region, dependencies, signal),
      region,
    };
  } catch (error) {
    if (
      !(error instanceof AlibabaUsageError) ||
      !error.retryInChina ||
      region.id !== "international"
    ) {
      throw error;
    }
    const china = REGIONS["china-mainland"];
    return {
      usage: await fetchCandidateUsage(candidate, china, dependencies, signal),
      region: china,
    };
  }
}

async function resolveSecToken(
  cookie: string,
  region: RegionConfig,
  dependencies: AlibabaDependencies,
  signal: AbortSignal,
): Promise<string> {
  let lastError: AlibabaUsageError | undefined;
  try {
    const dashboard = await requestResponse(
      region.dashboardURL,
      {
        method: "GET",
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: cookie,
          "User-Agent": "Mozilla/5.0 quota-axi",
        },
        signal,
      },
      dependencies,
      true,
    );
    if (dashboard.status === 200) {
      const token = extractSecTokenFromHtml(decodeUtf8(dashboard.body));
      if (token) return token;
    } else {
      try {
        assertUsableStatus(
          dashboard.status,
          "console",
          region.id === "international",
        );
      } catch (error) {
        lastError = asAlibabaUsageError(error);
      }
    }
  } catch (error) {
    lastError = asAlibabaUsageError(error);
  }

  throwIfAborted(signal);
  try {
    const userInfo = await requestResponse(
      `${region.gatewayURL}/tool/user/info.json`,
      {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          Cookie: cookie,
          Referer: `${region.gatewayURL}/`,
          "User-Agent": "Mozilla/5.0 quota-axi",
        },
        signal,
      },
      dependencies,
      true,
    );
    if (userInfo.status === 200) {
      try {
        const parsed = JSON.parse(decodeUtf8(userInfo.body)) as unknown;
        const token = findFirstString(expandEmbeddedJson(parsed), [
          "secToken",
          "sec_token",
        ]);
        if (token) return token;
      } catch {
        lastError = new AlibabaUsageError("alibaba_response_invalid");
      }
    } else {
      try {
        assertUsableStatus(
          userInfo.status,
          "console",
          region.id === "international",
        );
      } catch (error) {
        lastError = asAlibabaUsageError(error);
      }
    }
  } catch (error) {
    lastError = asAlibabaUsageError(error);
  }

  const cookieToken = cookieValue("sec_token", cookie);
  if (cookieToken) return cookieToken;
  if (lastError) throw lastError;
  throw new AlibabaUsageError(
    "alibaba_console_login_required",
    region.id === "international",
  );
}

export function extractSecTokenFromHtml(html: string): string | undefined {
  const patterns = [
    /SEC_TOKEN\s*:\s*["']([^"']+)["']/i,
    /secToken\s*:\s*["']([^"']+)["']/i,
    /sec_token\s*:\s*["']([^"']+)["']/i,
    /["']SEC_TOKEN["']\s*:\s*["']([^"']+)["']/i,
    /["']sec_token["']\s*:\s*["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    const token = match?.[1]?.trim();
    if (token && safeToken(token)) return token;
  }
  return undefined;
}

export function normalizeAlibabaPayload(
  payload: unknown,
  now = Date.now(),
  authMode: AlibabaAuthMode = "console",
  retryInChina = false,
): NormalizedAlibabaUsage {
  const expanded = expandEmbeddedJson(payload);
  const root = objectValue(expanded);
  if (!root) throw new AlibabaUsageError("alibaba_response_invalid");
  validateServerStatus(root, authMode, retryInChina);

  const instances = findFirstArray(root, INSTANCE_INFO_KEYS)
    ?.map(objectValue)
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const instanceRecords = instances ?? [];
  const instance = chooseActiveInstance(instanceRecords, now);
  let quota: Record<string, unknown> | undefined;
  if (instance && isActiveInstance(instance, now)) {
    quota = findQuotaInfo(instance);
    if (!quota && instanceRecords.length <= 1) {
      quota = findQuotaInfo(root, INSTANCE_INFO_KEYS);
    }
  } else {
    quota = findQuotaInfo(root, INSTANCE_INFO_KEYS);
  }
  const windows = quota ? normalizeWindows(quota) : [];
  const plan = findPlanName(instance) ?? findPlanName(root);
  const active = isActiveInstance(instance, now) || activeSignal(root, now);
  if (windows.length === 0 && !active) {
    throw new AlibabaUsageError("alibaba_quota_missing", retryInChina);
  }

  const modelData = collectModels(instance ?? root);
  return {
    ...(plan ? { plan } : {}),
    ...((findPeriod(instance ?? root) ?? findPeriod(root))
      ? { period: findPeriod(instance ?? root) ?? findPeriod(root) }
      : {}),
    ...(instanceIdentity(instance)
      ? { instance: instanceIdentity(instance) }
      : {}),
    ...(modelData.models.length > 0 ? { models: modelData.models } : {}),
    ...(modelData.multiplier !== undefined
      ? { multiplier: modelData.multiplier }
      : {}),
    ...(Object.keys(modelData.modelMultipliers).length > 0
      ? { modelMultipliers: modelData.modelMultipliers }
      : {}),
    ...(Object.keys(modelData.modelLabels).length > 0
      ? { modelLabels: modelData.modelLabels }
      : {}),
    windows,
  };
}

function parseUsageResponse(
  response: ResponseData,
  authMode: AlibabaAuthMode,
  now: number,
  retryInChina: boolean,
): NormalizedAlibabaUsage {
  assertUsableStatus(response.status, authMode, retryInChina);
  let payload: unknown;
  try {
    payload = JSON.parse(decodeUtf8(response.body)) as unknown;
  } catch {
    throw new AlibabaUsageError("alibaba_response_invalid");
  }
  return normalizeAlibabaPayload(payload, now, authMode, retryInChina);
}

function assertUsableStatus(
  status: number,
  authMode: AlibabaAuthMode,
  retryInChina: boolean,
): void {
  if (status === 200) return;
  if (status === 401 || status === 403) {
    throw new AlibabaUsageError(
      authMode === "console"
        ? "alibaba_console_login_required"
        : "alibaba_api_key_rejected",
      retryInChina,
    );
  }
  if (status === 429) throw new AlibabaUsageError("alibaba_rate_limited");
  throw new AlibabaUsageError(
    "alibaba_quota_http_error",
    authMode === "api-key" && retryInChina,
  );
}

async function requestResponse(
  input: string,
  init: RequestInit,
  dependencies: AlibabaDependencies,
  allowNon200 = false,
): Promise<ResponseData> {
  let response: Response;
  try {
    response = await dependencies.fetch(input, init);
  } catch (error) {
    if (
      isAbortError(error) ||
      (init.signal as AbortSignal | undefined)?.aborted
    ) {
      throw new AlibabaUsageError("alibaba_quota_timeout");
    }
    throw new AlibabaUsageError("alibaba_quota_network_error");
  }
  throwIfAborted(init.signal as AbortSignal | undefined);
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > dependencies.responseLimitBytes
  ) {
    cancelResponseBody(response);
    throw new AlibabaUsageError("alibaba_response_too_large");
  }
  let body: Uint8Array;
  try {
    body = await readBoundedBody(
      response,
      dependencies.responseLimitBytes,
      init.signal as AbortSignal | undefined,
    );
  } catch (error) {
    if (error instanceof AlibabaUsageError) throw error;
    if (
      isAbortError(error) ||
      (init.signal as AbortSignal | undefined)?.aborted
    ) {
      throw new AlibabaUsageError("alibaba_quota_timeout");
    }
    throw new AlibabaUsageError("alibaba_quota_network_error");
  }
  throwIfAborted(init.signal as AbortSignal | undefined);
  if (!allowNon200 && response.status !== 200) {
    assertUsableStatus(response.status, "api-key", false);
  }
  return { status: response.status, headers: response.headers, body };
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  try {
    void response.body.cancel().catch(() => undefined);
  } catch {
    return;
  }
}

async function readBoundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (!response.body) {
    const arrayBuffer = await withAbortSignal(
      Promise.resolve().then(() => response.arrayBuffer()),
      signal,
    );
    const body = new Uint8Array(arrayBuffer);
    if (body.byteLength > limit)
      throw new AlibabaUsageError("alibaba_response_too_large");
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cleanupStarted = false;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      return;
    }
  };
  const cancelReader = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    let cancellation: Promise<unknown>;
    try {
      cancellation = reader.cancel();
    } catch {
      if (!pendingRead) releaseReader();
      return;
    }
    void cancellation.then(
      () => {
        if (!pendingRead) releaseReader();
      },
      () => {
        if (!pendingRead) releaseReader();
      },
    );
    if (!pendingRead) releaseReader();
  };
  try {
    while (true) {
      pendingRead = Promise.resolve().then(() => reader.read());
      const { done, value } = await withAbortSignal(pendingRead, signal);
      pendingRead = undefined;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        cancelReader();
        throw new AlibabaUsageError("alibaba_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    if (pendingRead) {
      cancelReader();
      void pendingRead.then(releaseReader, releaseReader);
    } else if (!cleanupStarted) {
      releaseReader();
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function usageReport(
  candidate: AlibabaCandidate,
  usage: NormalizedAlibabaUsage,
  region: RegionConfig,
  now: number,
  attempts: SourceAttempt[],
): ProviderQuota {
  const credential =
    candidate.kind === "api-key" ? candidate.credential : undefined;
  const expiresAt = credential
    ? new Date(credential.expiresAtMs).toISOString()
    : undefined;
  const remainingMilliseconds = credential
    ? Math.max(0, credential.expiresAtMs - now)
    : undefined;
  const report: ProviderQuota = {
    provider: "alibaba",
    label: LABEL,
    source: candidate.kind === "cookie" ? "web" : "api",
    plan: usage.plan ?? LABEL,
    period: usage.period ?? DEFAULT_PERIOD,
    region: region.currentRegionId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(usage.models
      ? { models: usage.models }
      : { models: [...ALIBABA_MODELS] }),
    ...(usage.instance ? { instance: usage.instance } : {}),
    ...(usage.multiplier !== undefined ? { multiplier: usage.multiplier } : {}),
    ...(usage.modelMultipliers
      ? { modelMultipliers: usage.modelMultipliers }
      : {}),
    ...(usage.modelLabels
      ? { modelLabels: usage.modelLabels }
      : { modelLabels: { ...ALIBABA_MODEL_LABELS } }),
    ...(credential && remainingMilliseconds !== undefined
      ? {
          credential: {
            status:
              remainingMilliseconds <= 5 * 60 * 1_000
                ? ("expiring" as const)
                : ("fresh" as const),
            expiresAt,
            remainingSeconds: Math.floor(remainingMilliseconds / 1_000),
          },
        }
      : {}),
    windows: usage.windows,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(now).toISOString(),
      ...(usage.windows.length === 0
        ? { reason: ALIBABA_USAGE_CONSOLE_ONLY_REASON }
        : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
  return report;
}

function failedReport(
  error: string,
  status: ProviderStatus,
  attempts: SourceAttempt[],
  resolution: AlibabaCredentialResolution,
  environment: AlibabaEnvironment,
): ProviderQuota {
  const expiresAt =
    resolution.status === "expired"
      ? new Date(resolution.expiresAtMs).toISOString()
      : undefined;
  return {
    provider: "alibaba",
    label: LABEL,
    source: "unavailable",
    plan: LABEL,
    period: DEFAULT_PERIOD,
    region: configuredRegion(environment).currentRegionId,
    ...(expiresAt ? { expiresAt } : {}),
    ...(expiresAt
      ? {
          credential: {
            status: "expired" as const,
            expiresAt,
            remainingSeconds: 0,
          },
        }
      : {}),
    models: [...ALIBABA_MODELS],
    windows: [],
    state: {
      status,
      stale: false,
      error,
      ...(error === "alibaba_console_login_required"
        ? {
            reason: "configure_alibaba_cookie_or_api_key",
            remedyCommand:
              "set ALIBABA_CODING_PLAN_COOKIE or ALIBABA_CODING_PLAN_API_KEY",
          }
        : {}),
      ...(error === "alibaba_api_key_rejected"
        ? {
            reason: "alibaba_api_key_rejected",
            remedyCommand:
              "set ALIBABA_CODING_PLAN_API_KEY or ALIBABA_CODING_PLAN_COOKIE",
          }
        : {}),
      ...(error === "alibaba_api_key_unavailable_in_region"
        ? {
            reason: "alibaba_api_key_unavailable_in_region",
            remedyCommand: "set ALIBABA_CODING_PLAN_COOKIE",
          }
        : {}),
      ...(resolution.status === "expired" &&
      error === credentialError(resolution)
        ? { reason: "credentials_expired" }
        : {}),
      sourcesTried: attempts.map(({ source }) => source),
    },
    attempts,
  };
}

function providerStatusFor(error: string): ProviderStatus {
  if (
    ["alibaba_console_login_required", "alibaba_api_key_rejected"].includes(
      error,
    )
  ) {
    return "auth_required";
  }
  if (error === "alibaba_rate_limited") return "rate_limited";
  return "error";
}

function normalizeWindows(quota: Record<string, unknown>): QuotaWindow[] {
  const definitions = [
    {
      id: "five_hour",
      label: "5-hour",
      kind: "session" as const,
      used: QUOTA_FIELD_ALIASES.fiveHour.used,
      limit: QUOTA_FIELD_ALIASES.fiveHour.limit,
      reset: QUOTA_FIELD_ALIASES.fiveHour.reset,
      windowSeconds: FIVE_HOURS_SECONDS,
    },
    {
      id: "weekly",
      label: "weekly",
      kind: "weekly" as const,
      used: QUOTA_FIELD_ALIASES.weekly.used,
      limit: QUOTA_FIELD_ALIASES.weekly.limit,
      reset: QUOTA_FIELD_ALIASES.weekly.reset,
      windowSeconds: WEEK_SECONDS,
    },
    {
      id: "monthly",
      label: "billing month",
      kind: "monthly" as const,
      used: QUOTA_FIELD_ALIASES.monthly.used,
      limit: QUOTA_FIELD_ALIASES.monthly.limit,
      reset: QUOTA_FIELD_ALIASES.monthly.reset,
    },
  ];
  const windows: QuotaWindow[] = [];
  for (const definition of definitions) {
    const used = firstNumber(quota, definition.used);
    const limit = firstNumber(quota, definition.limit);
    if (used === undefined || limit === undefined || used < 0 || limit <= 0) {
      continue;
    }
    const percentUsed = clampPercent((used / limit) * 100);
    windows.push({
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      accounting: "request_quota",
      used,
      limit,
      percentUsed,
      percentRemaining: 100 - percentUsed,
      ...(definition.windowSeconds
        ? { windowSeconds: definition.windowSeconds }
        : {}),
      ...(firstTimestamp(quota, definition.reset)
        ? { resetsAt: firstTimestamp(quota, definition.reset) }
        : {}),
    });
  }
  return windows;
}

function chooseActiveInstance(
  instances: Record<string, unknown>[],
  now: number,
): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const instance of instances) {
    const score = activeScore(instance, now);
    if (!best || score > bestScore) {
      best = instance;
      bestScore = score;
    }
  }
  return best;
}

function activeScore(value: Record<string, unknown>, now: number): number {
  const status = firstString(value, [
    "status",
    "instanceStatus",
  ])?.toUpperCase();
  if (status === "ACTIVE" || status === "VALID") return 3;
  if (
    [
      "EXPIRED",
      "INVALID",
      "INACTIVE",
      "DISABLED",
      "TERMINATED",
      "STOPPED",
    ].includes(status ?? "")
  )
    return -1;
  const isActive = firstBoolean(value, ["isActive", "active"]);
  if (isActive !== undefined) return isActive ? 3 : -1;
  const expiry = firstTimestamp(value, [
    "endTime",
    "periodEndTime",
    "expireTime",
    "expirationTime",
  ]);
  return expiry && Date.parse(expiry) > now ? 1 : 0;
}

function isActiveInstance(
  value: Record<string, unknown> | undefined,
  now: number,
): boolean {
  return value ? activeScore(value, now) > 0 : false;
}

function activeSignal(value: Record<string, unknown>, now: number): boolean {
  const status = firstString(value, [
    "status",
    "instanceStatus",
  ])?.toUpperCase();
  return (
    status === "ACTIVE" || status === "VALID" || activeScore(value, now) > 0
  );
}

function findQuotaInfo(
  value: Record<string, unknown>,
  excludedKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  const direct = findFirstObject(value, QUOTA_INFO_KEYS, excludedKeys);
  if (direct) return direct;
  return findFirstObjectByFields(value, QUOTA_DISCOVERY_FIELDS, excludedKeys);
}

function findPlanName(
  value: Record<string, unknown> | undefined,
): string | undefined {
  if (!value) return undefined;
  return firstString(value, [
    "planName",
    "plan_name",
    "instanceName",
    "instance_name",
    "packageName",
    "package_name",
  ]);
}

function findPeriod(value: Record<string, unknown>): string | undefined {
  return firstString(value, [
    "period",
    "billingPeriod",
    "billing_period",
    "planPeriod",
    "plan_period",
  ]);
}

function instanceIdentity(
  value: Record<string, unknown> | undefined,
): ProviderQuota["instance"] | undefined {
  if (!value) return undefined;
  const id = firstString(value, [
    "instanceId",
    "instance_id",
    "codingPlanInstanceId",
    "coding_plan_instance_id",
    "id",
  ]);
  const name = firstString(value, [
    "instanceName",
    "instance_name",
    "packageName",
    "package_name",
  ]);
  const status = firstString(value, ["status", "instanceStatus"]);
  if (!id && !name && !status) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(status ? { status } : {}),
  };
}

function collectModels(value: Record<string, unknown>): {
  models: string[];
  multiplier?: number;
  modelMultipliers: Record<string, number>;
  modelLabels: Record<string, string>;
} {
  const models: string[] = [];
  const modelMultipliers: Record<string, number> = {};
  const modelLabels: Record<string, string> = {};
  for (const key of [
    "models",
    "modelNames",
    "model_names",
    "supportedModels",
    "modelList",
    "model_list",
  ]) {
    const entries = findFirstArray(value, [key]) ?? [];
    for (const entry of entries) {
      if (typeof entry === "string" && entry.trim()) {
        models.push(entry.trim());
      } else {
        const object = objectValue(entry);
        const name = object
          ? firstString(object, [
              "model",
              "modelName",
              "model_name",
              "name",
              "id",
            ])
          : undefined;
        if (!name) continue;
        models.push(name);
        const multiplier = object
          ? firstNumber(object, [
              "multiplier",
              "modelMultiplier",
              "model_multiplier",
              "quotaMultiplier",
              "quota_multiplier",
            ])
          : undefined;
        if (multiplier !== undefined) modelMultipliers[name] = multiplier;
        const label = object
          ? firstString(object, [
              "label",
              "displayName",
              "display_name",
              "description",
              "offerLabel",
              "offer_label",
            ])
          : undefined;
        if (label) modelLabels[name] = label;
      }
    }
  }
  const multiplier = firstNumber(value, [
    "multiplier",
    "quotaMultiplier",
    "quota_multiplier",
  ]);
  return {
    models: [...new Set(models)],
    ...(multiplier !== undefined ? { multiplier } : {}),
    modelMultipliers,
    modelLabels,
  };
}

function validateServerStatus(
  root: Record<string, unknown>,
  authMode: AlibabaAuthMode,
  retryInChina: boolean,
): void {
  const statusCode = findFirstNumber(root, [
    "statusCode",
    "status_code",
    "code",
  ]);
  if (statusCode !== undefined && statusCode !== 0 && statusCode !== 200) {
    if (statusCode === 401 || statusCode === 403) {
      throw new AlibabaUsageError(
        authMode === "console"
          ? "alibaba_console_login_required"
          : "alibaba_api_key_rejected",
        retryInChina,
      );
    }
    throw new AlibabaUsageError(
      "alibaba_quota_http_error",
      authMode === "api-key" && retryInChina,
    );
  }
  const statusText = findFirstString(root, [
    "code",
    "status",
    "statusCode",
    "errorCode",
    "error_code",
  ]);
  const messageText = findFirstString(root, [
    "statusMessage",
    "status_msg",
    "message",
    "msg",
  ]);
  for (const value of [statusText, messageText]) {
    const normalized = value?.toLowerCase() ?? "";
    if (
      authMode === "api-key" &&
      normalized.includes("api key mode may be unavailable")
    ) {
      throw new AlibabaUsageError(
        "alibaba_api_key_unavailable_in_region",
        retryInChina,
      );
    }
    if (
      normalized.includes("api key") ||
      normalized.includes("apikey") ||
      normalized.includes("unauthorized")
    ) {
      throw new AlibabaUsageError(
        authMode === "console"
          ? "alibaba_console_login_required"
          : "alibaba_api_key_rejected",
        retryInChina,
      );
    }
    if (
      normalized.includes("login") ||
      normalized.includes("needlogin") ||
      normalized.includes("console session")
    ) {
      throw new AlibabaUsageError(
        authMode === "console"
          ? "alibaba_console_login_required"
          : "alibaba_api_key_unavailable_in_region",
        retryInChina,
      );
    }
  }
}

function expandEmbeddedJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return expandEmbeddedJson(JSON.parse(trimmed) as unknown, depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map((item) => expandEmbeddedJson(item, depth + 1));
  const object = objectValue(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, nested]) => [
      key,
      expandEmbeddedJson(nested, depth + 1),
    ]),
  );
}

function findFirstObject(
  value: unknown,
  keys: readonly string[],
  excludedKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  const object = objectValue(value);
  if (object) {
    for (const key of keys) {
      const nested = objectValue(object[key]);
      if (nested) return nested;
    }
    for (const [key, nested] of Object.entries(object)) {
      if (excludedKeys.includes(key)) continue;
      const found = findFirstObject(nested, keys, excludedKeys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstObject(nested, keys, excludedKeys);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstObjectByFields(
  value: unknown,
  keys: readonly string[],
  excludedKeys: readonly string[] = [],
): Record<string, unknown> | undefined {
  const object = objectValue(value);
  if (object) {
    if (keys.some((key) => object[key] !== undefined)) return object;
    for (const [key, nested] of Object.entries(object)) {
      if (excludedKeys.includes(key)) continue;
      const found = findFirstObjectByFields(nested, keys, excludedKeys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstObjectByFields(nested, keys, excludedKeys);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstArray(
  value: unknown,
  keys: readonly string[],
): unknown[] | undefined {
  const object = objectValue(value);
  if (object) {
    for (const key of keys) {
      if (Array.isArray(object[key])) return object[key] as unknown[];
    }
    for (const nested of Object.values(object)) {
      const found = findFirstArray(nested, keys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstArray(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  const object = objectValue(value);
  if (object) {
    for (const key of keys) {
      const parsed = stringValue(object[key]);
      if (parsed) return parsed;
    }
    for (const nested of Object.values(object)) {
      const found = findFirstString(nested, keys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstString(nested, keys);
      if (found) return found;
    }
  }
  return undefined;
}

function findFirstNumber(value: unknown, keys: string[]): number | undefined {
  const object = objectValue(value);
  if (object) {
    const direct = firstNumber(object, keys);
    if (direct !== undefined) return direct;
    for (const nested of Object.values(object)) {
      const found = findFirstNumber(nested, keys);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(value)) {
    for (const nested of value) {
      const found = findFirstNumber(nested, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function firstString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const parsed = stringValue(value[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function firstNumber(
  value: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw)))
      return Number(raw);
  }
  return undefined;
}

function firstBoolean(
  value: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "boolean") return raw;
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
  }
  return undefined;
}

function firstTimestamp(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const parsed = timestamp(value[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function timestamp(value: unknown): string | undefined {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = Math.abs(value) >= 1e12 ? value : value * 1_000;
  } else if (typeof value === "string" && value.trim()) {
    const raw = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      milliseconds = Math.abs(numeric) >= 1e12 ? numeric : numeric * 1_000;
    } else {
      milliseconds = Date.parse(raw);
    }
  } else {
    return undefined;
  }
  return Number.isFinite(milliseconds) &&
    !Number.isNaN(new Date(milliseconds).getTime())
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function configuredCookie(environment: AlibabaEnvironment): string | undefined {
  const value = environment.ALIBABA_CODING_PLAN_COOKIE?.trim();
  if (
    !value ||
    value.length > COOKIE_LIMIT_CHARS ||
    hasControlCharacters(value)
  )
    return undefined;
  return value;
}

function configuredApiKey(environment: AlibabaEnvironment): string | undefined {
  for (const name of [
    "ALIBABA_CODING_PLAN_API_KEY",
    "ALIBABA_QWEN_API_KEY",
    "DASHSCOPE_API_KEY",
  ]) {
    const value = environment[name]?.trim();
    if (value && safeToken(value)) return value;
  }
  return undefined;
}

function configuredRegion(environment: AlibabaEnvironment): RegionConfig {
  const value = environment.ALIBABA_CODING_PLAN_REGION?.trim().toLowerCase();
  return value === "cn" || value === "china" || value === "cn-beijing"
    ? REGIONS["china-mainland"]
    : REGIONS.international;
}

function cookieValue(name: string, cookie: string): string | undefined {
  for (const segment of cookie.split(";")) {
    const index = segment.indexOf("=");
    if (index < 0) continue;
    if (segment.slice(0, index).trim() !== name) continue;
    const value = segment.slice(index + 1).trim();
    if (value && safeToken(value)) return value;
  }
  return undefined;
}

function csrfHeaders(cookie: string): Record<string, string> {
  const csrf =
    cookieValue("login_aliyunid_csrf", cookie) ?? cookieValue("csrf", cookie);
  return csrf ? { "x-xsrf-token": csrf, "x-csrf-token": csrf } : {};
}

function consoleRequestBody(
  region: RegionConfig,
  secToken: string,
  anonymousID: string | undefined,
): string {
  const cornerstoneParam: Record<string, unknown> = {
    feTraceId: randomUUID().toLowerCase(),
    feURL: region.dashboardURL,
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    domain: region.consoleDomain,
    consoleSite: region.consoleSite,
    userNickName: "",
    userPrincipalName: "",
    xsp_lang: "en-US",
    ...(anonymousID ? { "X-Anonymous-Id": anonymousID } : {}),
  };
  const params = {
    Api: "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2",
    V: "1.0",
    Data: {
      queryCodingPlanInstanceInfoRequest: {
        commodityCode: region.commodityCode,
        onlyLatestOne: true,
      },
      cornerstoneParam,
    },
  };
  return new URLSearchParams({
    params: JSON.stringify(params),
    region: region.currentRegionId,
    sec_token: secToken,
  }).toString();
}

function piAuthStatus(
  resolution: AlibabaCredentialResolution,
): AuthSourceReport["status"] {
  switch (resolution.status) {
    case "available":
      return "available";
    case "expired":
      return "expired";
    case "missing":
      return "missing";
    default:
      return "invalid";
  }
}

function credentialError(resolution: AlibabaCredentialResolution): string {
  switch (resolution.status) {
    case "available":
      return "alibaba_usage_source_unavailable";
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

function safeAlibabaError(error: unknown): string {
  return error instanceof AlibabaUsageError
    ? error.code
    : "alibaba_quota_unavailable";
}

function asAlibabaUsageError(error: unknown): AlibabaUsageError {
  return error instanceof AlibabaUsageError
    ? error
    : new AlibabaUsageError("alibaba_quota_network_error");
}

function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new AlibabaUsageError("alibaba_quota_timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new AlibabaUsageError("alibaba_quota_timeout"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AlibabaUsageError("alibaba_quota_timeout");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= COOKIE_LIMIT_CHARS &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}
