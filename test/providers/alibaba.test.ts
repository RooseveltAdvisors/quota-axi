import { describe, expect, it, vi } from "vitest";
import {
  ALIBABA_MODELS,
  ALIBABA_USAGE_CONSOLE_ONLY_REASON,
  createAlibabaAdapter,
  PI_ALIBABA_CREDENTIAL_SOURCE,
} from "../../src/providers/alibaba.js";
import type {
  AlibabaCredentialBroker,
  AlibabaCredentialResolution,
} from "../../src/providers/pi-alibaba-credential.js";

const NOW = Date.parse("2027-08-01T00:00:00.000Z");
const OPTIONS = { allowKeychainPrompt: false };

function brokerFor(
  resolution: AlibabaCredentialResolution,
): AlibabaCredentialBroker {
  return {
    resolve: vi.fn(async () => resolution),
    inspect: vi.fn(async () => resolution.status),
  };
}

describe("Alibaba Coding Plan quota", () => {
  it("reports entitlement identity and credential validity without numeric quota", async () => {
    const expiresAtMs = NOW + 86_400_000;
    const report = await createAlibabaAdapter({
      broker: brokerFor({
        status: "available",
        accessToken: "synthetic-alibaba-access-token",
        expiresAtMs,
      }),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      label: "Alibaba Coding Plan",
      source: "oauth",
      plan: "Alibaba Coding Plan",
      period: "annual",
      expiresAt: "2027-08-02T00:00:00.000Z",
      region: "ap-southeast-1",
      models: [...ALIBABA_MODELS],
      credential: {
        status: "fresh",
        expiresAt: "2027-08-02T00:00:00.000Z",
        remainingSeconds: 86_400,
      },
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        reason: ALIBABA_USAGE_CONSOLE_ONLY_REASON,
        sourcesTried: [PI_ALIBABA_CREDENTIAL_SOURCE],
      },
      attempts: [{ source: PI_ALIBABA_CREDENTIAL_SOURCE, status: "success" }],
    });
    expect(JSON.stringify(report)).not.toContain(
      "synthetic-alibaba-access-token",
    );
  });

  it("reports expired auth honestly and does not substitute stale quota", async () => {
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "expired", expiresAtMs: NOW - 1 }),
      now: () => NOW,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      source: "unavailable",
      windows: [],
      state: {
        status: "auth_required",
        error: "Alibaba Coding Plan access token expired",
        reason: "credentials_expired",
      },
      credential: { status: "expired", remainingSeconds: 0 },
    });
    expect(report.state.stale).toBe(false);
  });

  it("maps local auth inspection without exposing credentials", async () => {
    const report = await createAlibabaAdapter({
      broker: brokerFor({ status: "missing" }),
      now: () => NOW,
    }).inspectAuth(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      sources: [
        {
          source: PI_ALIBABA_CREDENTIAL_SOURCE,
          status: "missing",
          error: "alibaba_plan_credential_unavailable",
        },
      ],
    });
  });
});
