import { execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as path from "node:path";

export function execFileText(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let invocation: { command: string; args: string[] };
    try {
      invocation = shimInvocation(command, args);
    } catch (error) {
      reject(error);
      return;
    }
    execFile(
      invocation.command,
      invocation.args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function shimInvocation(
  command: string,
  args: string[],
): {
  command: string;
  args: string[];
} {
  if (
    process.platform !== "win32" ||
    ![".cmd", ".bat"].includes(path.win32.extname(command).toLowerCase())
  ) {
    return { command, args };
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const commandLine = [command, ...args]
    .map(quoteCmdArgument)
    .join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
  };
}

function quoteCmdArgument(value: string): string {
  if (/[\u0000-\u001f\u007f\r\n]/.test(value)) {
    throw new TypeError("Windows command arguments cannot contain controls");
  }
  const escaped = value
    .replace(/(["&|<>()^%])/g, "^$1");
  return `"${escaped}"`;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await findCommandPath(command)) !== undefined;
}

export async function findCommandPath(
  command: string,
): Promise<string | undefined> {
  const normalized = command.trim();
  if (normalized.length === 0) return undefined;
  for (const candidate of commandPathCandidates(normalized)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

function commandPathCandidates(command: string): string[] {
  if (hasPathSeparator(command)) return executableCandidates(command);
  const pathValue = process.env.PATH;
  if (!pathValue) return [];
  const pathApi = process.platform === "win32" ? path.win32 : path;
  const delimiter =
    process.platform === "win32" ? path.win32.delimiter : path.delimiter;
  return pathValue
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, "") || ".")
    .flatMap((entry) => executableCandidates(pathApi.join(entry, command)));
}

function executableCandidates(file: string): string[] {
  if (process.platform !== "win32") return [file];
  const pathApi = path.win32;
  if (pathApi.extname(file)) return [file];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return extensions.map((extension) => `${file}${extension}`);
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

export function terminateChild(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill("SIGTERM");
  if (child.exitCode !== null || child.signalCode !== null) return;
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 2000);
  forceKill.unref();
  child.once("exit", () => clearTimeout(forceKill));
}
