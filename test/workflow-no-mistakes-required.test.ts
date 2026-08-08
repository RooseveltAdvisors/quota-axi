import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

const WORKFLOW_PATH = ".github/workflows/no-mistakes-required.yml";
type WorkflowRecord = Record<string, unknown>;

function objectValue(value: unknown): WorkflowRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : undefined;
}

function loadWorkflow(): WorkflowRecord {
  const document = loadYaml(readFileSync(WORKFLOW_PATH, "utf8")) as unknown;
  expect(document).toBeDefined();
  expect(document).not.toBeNull();
  expect(typeof document).toBe("object");
  expect(Array.isArray(document)).toBe(false);
  return document as WorkflowRecord;
}

function loadWorkflowOn(): WorkflowRecord {
  const workflow = loadWorkflow();
  const on = workflow.on ?? workflow.true;
  expect(on).toBeDefined();
  expect(on).not.toBeNull();
  expect(typeof on).toBe("object");
  expect(Array.isArray(on)).toBe(false);
  return on as WorkflowRecord;
}

function loadPullRequestTargetTrigger(): WorkflowRecord {
  const on = loadWorkflowOn();
  const trigger = on.pull_request_target;
  expect(trigger).toBeDefined();
  expect(trigger).not.toBeNull();
  expect(typeof trigger).toBe("object");
  expect(Array.isArray(trigger)).toBe(false);
  return trigger as WorkflowRecord;
}

function loadCheckJob(): WorkflowRecord {
  const jobs = objectValue(loadWorkflow().jobs);
  const check = objectValue(jobs?.check);
  expect(check).toBeDefined();
  return check as WorkflowRecord;
}

function loadVerificationStep(): WorkflowRecord {
  const steps = loadCheckJob().steps;
  expect(Array.isArray(steps)).toBe(true);
  const step = (steps as unknown[])
    .map(objectValue)
    .find(
      (candidate) =>
        candidate?.name === "Verify no-mistakes signature in PR body",
    );
  expect(step).toBeDefined();
  return step as WorkflowRecord;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  const record = objectValue(value);
  return record ? Object.values(record).flatMap(stringValues) : [];
}

function executeVerification(body: string) {
  const run = loadVerificationStep().run;
  expect(typeof run).toBe("string");
  return spawnSync("bash", ["-euo", "pipefail", "-c", run as string], {
    encoding: "utf8",
    env: {
      ...process.env,
      PR_BODY: body,
      PR_AUTHOR: "workflow-test",
      PR_NUMBER: "123",
    },
  });
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
    expect(loadWorkflow().permissions).toEqual({ contents: "read" });
  });

  it("uses hosted runner with 5 minute timeout", () => {
    const check = loadCheckJob();
    expect(check["runs-on"]).toBe("ubuntu-latest");
    expect(check["timeout-minutes"]).toBe(5);
  });

  it("exempts release automation bots", () => {
    expect(loadCheckJob().if).toBe(
      "github.event.pull_request.user.login != 'github-actions[bot]' && github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.user.login != 'release-please[bot]'",
    );
  });

  it("accepts signed and rejects unsigned PR bodies", () => {
    const accepted = executeVerification(
      [
        "## Pipeline",
        "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)",
        '\"; exit 73; #',
      ].join("\n"),
    );
    expect(accepted.status).toBe(0);
    expect(accepted.error).toBeUndefined();

    const rejected = executeVerification("ordinary pull request body");
    expect(rejected.status).toBe(1);
    expect(rejected.error).toBeUndefined();
  });

  it("passes the PR metadata through the verification step environment", () => {
    const step = loadVerificationStep();
    const env = objectValue(step.env);
    expect(env).toMatchObject({
      PR_BODY: "${{ github.event.pull_request.body }}",
      PR_AUTHOR: "${{ github.event.pull_request.user.login }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
  });

  it("has no secrets reference and does not checkout PR head", () => {
    const workflow = loadWorkflow();
    expect(
      stringValues(workflow).some((value) => /secrets\./i.test(value)),
    ).toBe(false);

    const steps = loadCheckJob().steps;
    expect(Array.isArray(steps)).toBe(true);
    const uses = (steps as unknown[])
      .map(objectValue)
      .map((step) => step?.uses)
      .filter((value): value is string => typeof value === "string");
    expect(uses.some((value) => value.startsWith("actions/checkout@"))).toBe(
      false,
    );
  });

  it("regression: does not contain the bypassable pull_request trigger on main", () => {
    const on = loadWorkflowOn();
    const trigger = loadPullRequestTargetTrigger();
    expect(on.pull_request).toBeUndefined();
    expect(trigger.branches).toEqual(["main"]);
  });
});
