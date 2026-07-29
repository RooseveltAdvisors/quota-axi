import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const WORKFLOW_PATH = ".github/workflows/no-mistakes-required.yml";

function loadWorkflow() {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

describe("no-mistakes-required workflow (hardened pull_request_target gate)", () => {
  it("triggers on pull_request_target so base branch copy always runs", () => {
    const content = loadWorkflow();
    // Canonical hardened contract: pull_request_target, never pull_request at trigger level
    expect(content).toMatch(/^\s+pull_request_target:/m);
    expect(content).not.toMatch(/^\s+pull_request:\s*$/m);
  });

  it("emits on every PR (no branches or paths filters)", () => {
    const content = loadWorkflow();
    // No branch or path scoping so every PR emits the required check
    expect(content).not.toMatch(/^\s+branches:/m);
    expect(content).not.toMatch(/^\s+paths:/m);
    expect(content).not.toMatch(/^\s+paths-ignore:/m);
  });

  it("declares the four relevant PR event types", () => {
    const content = loadWorkflow();
    expect(content).toContain("types: [opened, edited, synchronize, reopened]");
  });

  it("uses contents: read only and no write permissions", () => {
    const content = loadWorkflow();
    expect(content).toMatch(/permissions:\s*\n\s+contents: read/m);
    // No write grants anywhere in permissions
    expect(content).not.toMatch(/contents:\s*write/i);
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
    expect(content).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
    // Must not interpolate body directly into the run script (injection risk)
    expect(content).not.toMatch(
      /\$\{\{\s*github\.event\.pull_request\.body\s*\}\}[\s\S]{0,30}run:/,
    );
  });

  it("has no secrets reference and does not checkout PR head", () => {
    const content = loadWorkflow();
    expect(content).not.toMatch(/secrets\./i);
    expect(content).not.toMatch(/actions\/checkout/i);
  });

  it("regression: does not contain the bypassable pull_request trigger on main", () => {
    const content = loadWorkflow();
    // This is the key regression pin: old form used "pull_request: ... branches: [main]"
    // Hardened form must never regress to that self-bypassable trigger.
    // A PR editing this file would run the PR-head definition under pull_request.
    expect(content).not.toMatch(/^\s+pull_request:\s*$/m);
    expect(content).not.toContain("branches:\n      - main");
  });
});
