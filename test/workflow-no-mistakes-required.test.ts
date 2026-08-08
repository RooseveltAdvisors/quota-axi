import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/no-mistakes-required.yml";

function loadWorkflow() {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

function loadWorkflowOn(): Record<string, unknown> {
  const document = loadYaml(loadWorkflow()) as
    | Record<string | boolean, unknown>
    | null
    | undefined;
  const on = document?.on ?? document?.true;
  expect(on).toBeDefined();
  expect(on).not.toBeNull();
  expect(typeof on).toBe("object");
  expect(Array.isArray(on)).toBe(false);
  return on as Record<string, unknown>;
}

function loadPullRequestTargetTrigger(): Record<string, unknown> {
  const on = loadWorkflowOn();
  const trigger = on.pull_request_target;
  expect(trigger).toBeDefined();
  expect(trigger).not.toBeNull();
  expect(typeof trigger).toBe("object");
  expect(Array.isArray(trigger)).toBe(false);
  return trigger as Record<string, unknown>;
}

function extractIndentedBlock(content: string, key: string) {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line === `${key}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex((line) => line !== "" && !/^\s/.test(line));

  return remaining.slice(0, end === -1 ? undefined : end).join("\n");
}

function extractRunScript(content: string) {
  const match = content.match(/^\s+run:\s*\|\s*\n((?: {10}.*(?:\n|$))*)/m);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("no-mistakes-required workflow (hardened pull_request_target gate)", () => {
  it("triggers on pull_request_target so base branch copy always runs", () => {
    const on = loadWorkflowOn();
    expect(on.pull_request_target).toBeDefined();
    expect(on.pull_request).toBeUndefined();
  });

  it("keeps the upstream release-output exclusions on the hardened trigger", () => {
    const trigger = loadPullRequestTargetTrigger();
    expect(trigger.branches).toEqual(["main"]);
    expect(trigger["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
  });

  it("declares the four relevant PR event types", () => {
    const trigger = loadPullRequestTargetTrigger();
    expect(trigger.types).toEqual(["opened", "edited", "synchronize", "reopened"]);
  });

  it("uses contents: read only and no write permissions", () => {
    const content = loadWorkflow();
    const permissions = extractIndentedBlock(content, "permissions");
    expect(permissions.trim()).toBe("contents: read");
  });

  it("uses hosted runner with 5 minute timeout", () => {
    const content = loadWorkflow();
    expect(content).toContain("runs-on: ubuntu-latest");
    expect(content).toContain("timeout-minutes: 5");
  });

  it("exempts release automation bots", () => {
    const content = loadWorkflow();
    const exempt = [
      "github-actions[bot]",
      "dependabot[bot]",
      "release-please[bot]",
    ];
    for (const login of exempt) {
      expect(content).toContain(
        `github.event.pull_request.user.login != '${login}'`,
      );
    }
  });

  it("checks for the deterministic no-mistakes PR body signature marker", () => {
    const content = loadWorkflow();
    const marker =
      "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
    expect(content).toContain(marker);
  });

  it("reads PR body via environment variable (not direct interpolation)", () => {
    const content = loadWorkflow();
    const runScript = extractRunScript(content);
    expect(content).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
    expect(runScript).not.toMatch(
      /\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/,
    );
  });

  it("has no secrets reference and does not checkout PR head", () => {
    const content = loadWorkflow();
    expect(content).not.toMatch(/secrets\./i);
    expect(content).not.toMatch(/actions\/checkout/i);
  });

  it("regression: does not contain the bypassable pull_request trigger on main", () => {
    const on = loadWorkflowOn();
    const trigger = loadPullRequestTargetTrigger();
    expect(on.pull_request).toBeUndefined();
    expect(trigger.branches).toEqual(["main"]);
  });
});
