import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, loadUserEnv } from "../../src/lib/env.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-env-"));
  return tempDir;
}

describe("quota-axi user env loading", () => {
  it("fails soft when the file is missing", () => {
    const environment: Record<string, string | undefined> = {};

    expect(() =>
      loadEnvFile(join(makeTempDir(), "missing"), environment),
    ).not.toThrow();
    expect(environment).toEqual({});
  });

  it("ignores blank lines and comments and loads key/value pairs", () => {
    const directory = makeTempDir();
    const filePath = join(directory, "env");
    writeFileSync(
      filePath,
      "\n# local quota credentials\n ALIBABA_TOKEN_PLAN_COOKIE = cookie-fixture-123 \nexport ALIBABA_CODING_PLAN_REGION=cn-beijing\n",
    );
    const environment: Record<string, string | undefined> = {};

    loadEnvFile(filePath, environment);

    expect(environment).toEqual({
      ALIBABA_TOKEN_PLAN_COOKIE: "cookie-fixture-123",
      ALIBABA_CODING_PLAN_REGION: "cn-beijing",
    });
  });

  it("does not override variables already in the environment", () => {
    const directory = makeTempDir();
    const filePath = join(directory, "env");
    writeFileSync(
      filePath,
      "ALIBABA_TOKEN_PLAN_COOKIE=file-cookie\nALIBABA_CODING_PLAN_REGION=file-region\n",
    );
    const environment: Record<string, string | undefined> = {
      ALIBABA_TOKEN_PLAN_COOKIE: "preset-cookie",
      ALIBABA_CODING_PLAN_REGION: "preset-region",
    };

    loadEnvFile(filePath, environment);

    expect(environment).toEqual({
      ALIBABA_TOKEN_PLAN_COOKIE: "preset-cookie",
      ALIBABA_CODING_PLAN_REGION: "preset-region",
    });
  });

  it("uses the XDG config path by default and supports the path override", () => {
    const directory = makeTempDir();
    const defaultFile = join(directory, "quota-axi", "env");
    const overrideFile = join(directory, "override-env");
    const environment: Record<string, string | undefined> = {
      XDG_CONFIG_HOME: directory,
    };
    mkdirSync(join(directory, "quota-axi"));
    writeFileSync(defaultFile, "ALIBABA_TOKEN_PLAN_COOKIE=xdg-cookie\n");

    expect(() => loadUserEnv(environment)).not.toThrow();
    expect(environment.ALIBABA_TOKEN_PLAN_COOKIE).toBe("xdg-cookie");

    writeFileSync(overrideFile, "ALIBABA_TOKEN_PLAN_COOKIE=override-cookie\n");
    delete environment.ALIBABA_TOKEN_PLAN_COOKIE;
    environment.QUOTA_AXI_ENV_FILE = overrideFile;
    loadUserEnv(environment);
    expect(environment.ALIBABA_TOKEN_PLAN_COOKIE).toBe("override-cookie");
  });
});
