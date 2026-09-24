import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMimoAdapter,
  MIMO_ENV_SOURCE,
  MIMO_PI_PROVIDER_IDS,
  MIMO_PI_SOURCE,
  resolveMimoCredentials,
} from "../../src/providers/mimo.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const SYNTHETIC_MIMO_KEY = "synthetic-mimo-key";

let piDir: string;
const piPath = () => join(piDir, "auth.json");

beforeEach(() => {
  piDir = mkdtempSync(join(tmpdir(), "quota-axi-mimo-"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(piDir, { recursive: true, force: true });
});

function writePiStore(store: unknown): void {
  writeFileSync(piPath(), JSON.stringify(store), { mode: 0o600 });
}

/** Binds the adapter to this test's Pi store so no machine credential decides. */
function adapterFor(
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  return createMimoAdapter({
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
    credential: () => resolveMimoCredentials(environment, piPath()),
  });
}

/** MiMo never sends a request: a usable key is model auth, not a quota read. */
function stubNoFetch() {
  const fetch = vi.fn(async () => {
    throw new Error("MiMo must not send a quota request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("MiMo provider", () => {
  it("reports local model authentication as usable without fabricating dashboard quota", async () => {
    const fetch = stubNoFetch();

    const report = await adapterFor({
      MIMO_API_KEY: SYNTHETIC_MIMO_KEY,
    }).fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "mimo",
      source: "api",
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        authStatus: "usable",
        sourcesTried: [MIMO_ENV_SOURCE],
      },
      attempts: [{ source: MIMO_ENV_SOURCE, status: "success" }],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(MIMO_PI_PROVIDER_IDS)(
    "reads Pi's %s entry as a usable credential",
    async (piProviderId) => {
      const fetch = stubNoFetch();
      writePiStore({
        [piProviderId]: { type: "api_key", key: SYNTHETIC_MIMO_KEY },
      });

      const report = await adapterFor().fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        provider: "mimo",
        source: "api",
        windows: [],
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          sourcesTried: [MIMO_ENV_SOURCE, MIMO_PI_SOURCE],
        },
        attempts: [
          {
            source: MIMO_ENV_SOURCE,
            status: "skipped",
            error: "mimo_credential_unavailable",
          },
          { source: MIMO_PI_SOURCE, status: "success" },
        ],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the environment credential first in the declared source order", async () => {
    writePiStore({ xiaomi: { type: "api_key", key: SYNTHETIC_MIMO_KEY } });

    const report = await adapterFor({
      MIMO_API_KEY: "env-key",
    }).fetchQuota(OPTIONS);

    expect(report.state.sourcesTried).toEqual([MIMO_ENV_SOURCE]);
    expect(report.attempts).toEqual([
      { source: MIMO_ENV_SOURCE, status: "success" },
    ]);
  });

  it("treats template and missing API keys as unavailable", () => {
    expect(
      resolveMimoCredentials({ MIMO_API_KEY: "${MIMO_API_KEY}" }, piPath()),
    ).toEqual([
      { status: "missing", source: MIMO_ENV_SOURCE },
      { status: "missing", source: MIMO_PI_SOURCE, path: piPath() },
    ]);
  });

  it("reports a machine without any MiMo credential as not set up", async () => {
    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      source: "unavailable",
      state: {
        status: "auth_required",
        error: "mimo_credential_unavailable",
        sourcesTried: [MIMO_ENV_SOURCE, MIMO_PI_SOURCE],
      },
    });
    expect(report.attempts).toEqual([
      {
        source: MIMO_ENV_SOURCE,
        status: "skipped",
        error: "mimo_credential_unavailable",
      },
      {
        source: MIMO_PI_SOURCE,
        status: "skipped",
        error: "mimo_credential_unavailable",
      },
    ]);
    for (const attempt of report.attempts ?? []) {
      expect(attempt.credentialPresent).toBeUndefined();
    }
  });

  it.each([
    ["empty entry", {}],
    ["entry without a key", { type: "api_key" }],
    ["unknown entry type", { type: "totally-unknown", access: "x" }],
    ["OAuth-shaped entry", { type: "oauth", access: "x" }],
  ])(
    "keeps a present but unusable Pi entry visible as a credential",
    async (_label, entry) => {
      writePiStore({ "xiaomi-token-plan-sgp": entry });

      const report = await adapterFor().fetchQuota(OPTIONS);

      expect(report).toMatchObject({
        source: "unavailable",
        state: {
          status: "auth_required",
          error: "mimo_credential_invalid",
        },
      });
      expect(report.attempts).toContainEqual({
        source: MIMO_PI_SOURCE,
        status: "failed",
        error: "mimo_credential_invalid",
        credentialPresent: true,
      });
    },
  );

  it("marks an unparseable Pi store as present rather than absent", async () => {
    writeFileSync(piPath(), "not json", { mode: 0o600 });

    const report = await adapterFor().fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    expect(report.attempts).toContainEqual({
      source: MIMO_PI_SOURCE,
      status: "failed",
      error: "mimo_credential_invalid",
      credentialPresent: true,
    });
  });

  it("inspects both credential sources with the stored key's presence", async () => {
    writePiStore({ xiaomi: { type: "api_key", key: SYNTHETIC_MIMO_KEY } });

    const auth = await adapterFor().inspectAuth(OPTIONS);

    expect(auth).toEqual({
      provider: "mimo",
      sources: [
        { source: MIMO_ENV_SOURCE, status: "missing" },
        {
          source: MIMO_PI_SOURCE,
          path: piPath(),
          status: "available",
          credentialPresent: true,
        },
      ],
    });
  });
});
