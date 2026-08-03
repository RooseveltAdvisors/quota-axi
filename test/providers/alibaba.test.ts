import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ALIBABA_API_KEY_SOURCE,
  ALIBABA_COOKIE_SOURCE,
  ALIBABA_USAGE_CONSOLE_ONLY_REASON,
  createAlibabaAdapter,
  extractSecTokenFromHtml,
  normalizeAlibabaPayload,
  PI_ALIBABA_CREDENTIAL_SOURCE,
} from "../../src/providers/alibaba.js";
import type {
  AlibabaCredentialBroker,
  AlibabaCredentialResolution,
} from "../../src/providers/pi-alibaba-credential.js";

const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../fixtures/alibaba/console-rpc.json", import.meta.url),
    ),
    "utf8",
  ),
) as unknown;

function brokerFor(
  resolution: AlibabaCredentialResolution,
): AlibabaCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => resolution.status),
  };
}

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

function availableCredential(): AlibabaCredentialResolution {
  return {
    status: "available",
    accessToken: "synthetic-alibaba-access-token",
    expiresAtMs: NOW + 86_400_000,
  };
}

describe("Alibaba Coding Plan quota", () => {
  it("uses the Pi credential through the API-key path and normalizes all request windows", async () => {
    const fetch = vi.fn(async () => response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      source: "api",
      plan: "Fixture Coding Plan",
      period: "monthly",
      region: "ap-southeast-1",
      instance: {
        id: "fixture-instance",
        name: "Fixture Coding Plan",
        status: "ACTIVE",
      },
      models: ["Fixture Model"],
      modelMultipliers: { "Fixture Model": 1.25 },
      modelLabels: { "Fixture Model": "Fixture Model label" },
      windows: [
        {
          id: "five_hour",
          kind: "session",
          accounting: "request_quota",
          used: 25,
          limit: 100,
          percentUsed: 25,
          percentRemaining: 75,
          windowSeconds: 18_000,
          resetsAt: "2030-01-01T05:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          accounting: "request_quota",
          used: 200,
          limit: 1_000,
          percentUsed: 20,
          percentRemaining: 80,
          windowSeconds: 604_800,
        },
        {
          id: "monthly",
          kind: "monthly",
          accounting: "request_quota",
          used: 300,
          limit: 2_000,
          percentUsed: 15,
          percentRemaining: 85,
        },
      ],
      state: {
        status: "fresh",
        sourcesTried: [PI_ALIBABA_CREDENTIAL_SOURCE],
      },
    });
    expect(report.credits).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain(
      "synthetic-alibaba-access-token",
    );
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("queryCodingPlanInstanceInfoV2");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(
      "synthetic-alibaba-access-token",
    );
    expect(String(init.body)).toContain("sfm_codingplan_public_intl");
  });

  it("retries API failures against China with the matching region contract", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      region: "cn-beijing",
      state: { status: "fresh" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [internationalURL, internationalInit] = fetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    const [chinaURL, chinaInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(internationalURL).toContain(
      "modelstudio.console.alibabacloud.com/data/api.json",
    );
    expect(String(internationalInit.body)).toContain(
      "sfm_codingplan_public_intl",
    );
    expect(chinaURL).toContain("bailian.console.aliyun.com/data/api.json");
    expect(String(chinaInit.body)).toContain("sfm_codingplan_public_cn");
    expect((chinaInit.headers as Record<string, string>).Origin).toBe(
      "https://bailian.console.aliyun.com",
    );
  });

  it("prefers a configured CodexBar-compatible cookie and discovers sec_token from the dashboard", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<script>window.CONFIG={SEC_TOKEN: "synthetic-sec-token"}</script>',
        ),
      )
      .mockResolvedValueOnce(response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      fetch,
      environment: {
        ALIBABA_CODING_PLAN_COOKIE:
          "cna=synthetic-cna; session=synthetic-session",
      },
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.source).toBe("web");
    expect(report.state.sourcesTried).toEqual([ALIBABA_COOKIE_SOURCE]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [rpcURL, rpcInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(rpcURL).toContain("IntlBroadScopeAspnGateway");
    expect((rpcInit.headers as Record<string, string>).Cookie).toContain(
      "synthetic-session",
    );
    const params = new URLSearchParams(String(rpcInit.body));
    expect(params.get("region")).toBe("ap-southeast-1");
    expect(params.get("sec_token")).toBe("synthetic-sec-token");
    expect(params.get("params")).toContain("onlyLatestOne");
    expect((rpcInit.headers as Record<string, string>).Referer).toBe(
      "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan",
    );
  });

  it("uses the China console RPC and dashboard paths for cookie authentication", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          '<script>window.CONFIG={SEC_TOKEN: "synthetic-cn-token"}</script>',
        ),
      )
      .mockResolvedValueOnce(response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      fetch,
      environment: {
        ALIBABA_CODING_PLAN_COOKIE: "session=synthetic-session",
        ALIBABA_CODING_PLAN_REGION: "cn-beijing",
      },
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "web",
      region: "cn-beijing",
      state: { status: "fresh" },
    });
    const [dashboardURL] = fetch.mock.calls[0] as [string, RequestInit];
    const [rpcURL, rpcInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect(dashboardURL).toContain(
      "https://bailian.console.aliyun.com/cn-beijing/",
    );
    expect(rpcURL).toContain("bailian-cs.console.aliyun.com");
    expect(rpcURL).toContain("action=BroadScopeAspnGateway");
    const params = new URLSearchParams(String(rpcInit.body));
    expect(params.get("region")).toBe("cn-beijing");
    expect(params.get("params")).toContain("sfm_codingplan_public_cn");
    expect(params.get("params")).toContain("BAILIAN_ALIYUN");
    expect((rpcInit.headers as Record<string, string>).Origin).toBe(
      "https://bailian.console.aliyun.com",
    );
  });

  it("falls back to user-info and then a cookie sec_token without exposing it", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response("<html>no token</html>"))
      .mockResolvedValueOnce(
        response({ data: { sec_token: "synthetic-info-token" } }),
      )
      .mockResolvedValueOnce(response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      fetch,
      environment: {
        ALIBABA_CODING_PLAN_COOKIE: "session=synthetic-session",
      },
      now: () => NOW,
    }).fetchQuota(OPTIONS);
    expect(report.state.status).toBe("fresh");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(report)).not.toContain("synthetic-info-token");
  });

  it("selects an ambient API key only when Pi and cookie sources are unavailable", async () => {
    const fetch = vi.fn(async () => response(FIXTURE));
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      fetch,
      environment: { ALIBABA_CODING_PLAN_API_KEY: "synthetic-api-key" },
      now: () => NOW,
    }).fetchQuota(OPTIONS);
    expect(report.source).toBe("api");
    expect(report.state.sourcesTried).toEqual([ALIBABA_API_KEY_SOURCE]);
  });

  it("reports missing and expired authentication without substituting quota", async () => {
    const missing = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);
    expect(missing).toMatchObject({
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        error: "alibaba_plan_credential_unavailable",
      },
    });

    const expired = await createAlibabaAdapter({
      broker: brokerFor({ status: "expired", expiresAtMs: NOW - 1 }),
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);
    expect(expired).toMatchObject({
      state: {
        status: "auth_required",
        error: "Alibaba Coding Plan access token expired",
        reason: "credentials_expired",
      },
      credential: { status: "expired", remainingSeconds: 0 },
      windows: [],
    });
  });

  it("keeps active-plan identity explicit when the server omits authoritative counters", async () => {
    const payload = {
      data: {
        codingPlanInstanceInfos: [
          { planName: "No Counter Plan", status: "ACTIVE" },
        ],
      },
    };
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch: vi.fn(async () => response(payload)),
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);
    expect(report).toMatchObject({
      source: "api",
      plan: "No Counter Plan",
      windows: [],
      state: { status: "fresh", reason: ALIBABA_USAGE_CONSOLE_ONLY_REASON },
    });
  });

  it("does not borrow quota counters from a different plan instance", () => {
    const normalized = normalizeAlibabaPayload(
      {
        data: {
          codingPlanInstanceInfos: [
            {
              instanceId: "expired-instance",
              planName: "Expired Plan",
              status: "EXPIRED",
              codingPlanQuotaInfo: {
                per5HourUsedQuota: 90,
                per5HourTotalQuota: 100,
              },
            },
            {
              instanceId: "active-instance",
              planName: "Active Plan",
              status: "ACTIVE",
            },
          ],
        },
      },
      NOW,
    );

    expect(normalized).toMatchObject({
      plan: "Active Plan",
      windows: [],
    });
  });

  it("surfaces API-mode console login as a regional API limitation", async () => {
    const fetch = vi.fn(async () =>
      response({ code: "0", statusMessage: "ConsoleNeedLogin" }),
    );
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      state: {
        status: "error",
        error: "alibaba_api_key_unavailable_in_region",
        reason: "alibaba_api_key_unavailable_in_region",
        remedyCommand: "set ALIBABA_CODING_PLAN_COOKIE",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps rejected API credentials to auth_required with remediation", async () => {
    const fetch = vi.fn(async () => response({}, 401));
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      state: {
        status: "auth_required",
        error: "alibaba_api_key_rejected",
        reason: "alibaba_api_key_rejected",
      },
    });
    expect(report.state.remedyCommand).toContain("ALIBABA_CODING_PLAN_API_KEY");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps console discovery HTTP failures distinct from login", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response("dashboard unavailable", 503))
      .mockResolvedValueOnce(response("user info unavailable", 503));
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      fetch,
      environment: {
        ALIBABA_CODING_PLAN_COOKIE: "session=synthetic-session",
        ALIBABA_CODING_PLAN_REGION: "cn-beijing",
      },
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      windows: [],
      state: { status: "error", error: "alibaba_quota_http_error" },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("enforces one deadline across all configured candidate sources", async () => {
    const fetch = vi.fn(
      async (_input: string, init?: RequestInit): Promise<Response> =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        }),
    );
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {
        ALIBABA_CODING_PLAN_COOKIE: "session=synthetic-session",
        ALIBABA_CODING_PLAN_API_KEY: "synthetic-api-key",
      },
      deadlineMs: 20,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "alibaba_quota_timeout",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies response body stream failures as network errors", async () => {
    const failedResponse = {
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => Promise.reject(new Error("stream failed")),
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response;
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch: vi.fn(async () => failedResponse),
      environment: {},
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "alibaba_quota_network_error",
    });
  });

  it("bounds a response body that ignores the operation signal", async () => {
    const hangingResponse = {
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => {}),
          releaseLock: vi.fn(),
        }),
      },
    } as unknown as Response;
    const fetch = vi.fn(async () => hangingResponse);
    const report = await createAlibabaAdapter({
      broker: brokerFor(availableCredential()),
      fetch,
      environment: {},
      deadlineMs: 20,
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report.state).toMatchObject({
      status: "error",
      error: "alibaba_quota_timeout",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed", response("not-json"), "alibaba_response_invalid"],
    [
      "oversized",
      response("01234567890123456789"),
      "alibaba_response_too_large",
    ],
  ] as const)(
    "redacts %s response diagnostics",
    async (_name, serverResponse, error) => {
      const report = await createAlibabaAdapter({
        broker: brokerFor(availableCredential()),
        fetch: vi.fn(async () => serverResponse),
        environment: {},
        responseLimitBytes: 16,
        now: () => NOW,
      }).fetchQuota(OPTIONS);
      expect(report.state.error).toBe(error);
      expect(report.state.error).not.toContain("0123456789");
    },
  );

  it("recognizes HTML sec_token syntax and rejects malformed payloads", () => {
    expect(extractSecTokenFromHtml("SEC_TOKEN: 'synthetic-token'")).toBe(
      "synthetic-token",
    );
    expect(extractSecTokenFromHtml("<html>none</html>")).toBeUndefined();
    expect(() => normalizeAlibabaPayload({ data: "not quota" }, NOW)).toThrow(
      "alibaba_quota_missing",
    );
  });
});
