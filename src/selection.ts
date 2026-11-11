import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isRecord } from "./models-file.ts";

export const processProfileVariable = "KILO_MODEL_PROFILE";

export function processProfile(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[processProfileVariable]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

export function configurationDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.KILO_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    return path.resolve(configured);
  }
  const xdg = environment.XDG_CONFIG_HOME?.replace(/[\r\n]+/g, "");
  return xdg !== undefined && path.isAbsolute(xdg)
    ? path.join(xdg, "kilo")
    : path.join(homedir().replace(/[\r\n]+/g, ""), ".config", "kilo");
}

/** Kilo keeps `auth.json` in its data directory, which also follows xdg-basedir on every platform. */
export function dataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = environment.XDG_DATA_HOME?.replace(/[\r\n]+/g, "");
  return path.join(
    xdg !== undefined && path.isAbsolute(xdg)
      ? xdg
      : path.join(homedir().replace(/[\r\n]+/g, ""), ".local", "share"),
    "kilo",
  );
}

/** Kilo initializes its state directory before loading plugins, including a sticky data/state fallback. */
export function stateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = environment.XDG_STATE_HOME?.replace(/[\r\n]+/g, "");
  if (
    environment.XDG_STATE_HOME === undefined ||
    environment.XDG_STATE_HOME === ""
  ) {
    const fallback = path.join(dataDirectory(environment), "state");
    try {
      if (statSync(fallback).isDirectory()) {
        accessSync(fallback, constants.W_OK);
        return fallback;
      }
    } catch {
      // The host selected its preferred state directory instead.
    }
  }
  return path.join(
    xdg !== undefined && path.isAbsolute(xdg)
      ? xdg
      : path.join(homedir().replace(/[\r\n]+/g, ""), ".local", "state"),
    "kilo",
  );
}

/** Kilo keeps its copy of the models.dev catalog in its cache directory, which follows xdg-basedir too. */
export function cacheDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = environment.XDG_CACHE_HOME?.replace(/[\r\n]+/g, "");
  return path.join(
    xdg !== undefined && path.isAbsolute(xdg)
      ? xdg
      : path.join(homedir().replace(/[\r\n]+/g, ""), ".cache"),
    "kilo",
  );
}

/** Outside a git repository Kilo reports the worktree as "/", so the directory stands in for it. */
export function worktreeRoot(worktree: unknown, directory: unknown): string {
  if (typeof worktree === "string" && worktree !== "" && worktree !== "/") {
    return worktree;
  }
  return typeof directory === "string" && directory !== ""
    ? directory
    : process.cwd();
}

/** `resolve` already drops trailing separators except at a root, so equivalent spellings share a key. */
function worktreeKey(worktree: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? path.win32.resolve(worktree).toLowerCase()
    : path.posix.resolve(worktree);
}

export function selectionFilePath(
  state: string,
  worktree: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const key = createHash("sha256")
    .update(worktreeKey(worktree, platform))
    .digest("hex")
    .slice(0, 32);
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  return platformPath.join(state, "model-profiles", "worktrees", `${key}.json`);
}

/** `null` saves "defaults only"; `undefined` means nothing is saved for this worktree. */
export type SavedProfile = string | null | undefined;

export interface SavedSelection {
  profile: SavedProfile;
  notice?: string;
}

export async function readSavedSelection(
  file: string,
): Promise<SavedSelection> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { profile: undefined };
    }
    return {
      profile: undefined,
      notice: `Could not read the saved profile at ${file}; using the default selection.`,
    };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (
      isRecord(value) &&
      value.version === 1 &&
      (value.profile === null ||
        (typeof value.profile === "string" && value.profile !== ""))
    ) {
      return { profile: value.profile };
    }
  } catch {
    // An unreadable selection is reported below like any other invalid content.
  }
  return {
    profile: undefined,
    notice: `The saved profile at ${file} is invalid; using the default selection. Pick a profile with /model-config to replace it.`,
  };
}

export async function saveSelection(
  file: string,
  worktree: string,
  profile: string | null,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, worktree, profile }, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearSelection(file: string): Promise<void> {
  await rm(file, { force: true });
}
