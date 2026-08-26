import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs";

export const DIFF_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

export type DiffTheme = (typeof DIFF_THEMES)[keyof typeof DIFF_THEMES];

export function diffTheme(dark: boolean): DiffTheme {
  return dark ? DIFF_THEMES.dark : DIFF_THEMES.light;
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const SECOND_SEED = 0x9e3779b9;
const SECOND_PRIME = 0x85ebca6b;

function fnv1a32(input: string, seed: number, prime: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash >>> 0;
}

/** Two hashes plus the length, so the renderer's cache never reuses one patch's tokens for another. */
function cacheKey(patch: string): string {
  const first = fnv1a32(patch, FNV_OFFSET, FNV_PRIME).toString(36);
  const second = fnv1a32(patch, SECOND_SEED, SECOND_PRIME).toString(36);
  return `diff:${patch.length}:${first}:${second}`;
}

export type ParsedDiff =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

export function parseDiff(patch: string): ParsedDiff | undefined {
  const text = patch.trim();
  if (text === "") return undefined;

  try {
    const parsed = parsePatchFiles(text, cacheKey(text));
    const files = parsed.flatMap((one) => one.files);
    if (files.length > 0) return { kind: "files", files };
    return { kind: "raw", text, reason: "Unsupported diff format." };
  } catch {
    return { kind: "raw", text, reason: "The patch would not parse." };
  }
}

export type DiffStat = { files: number; additions: number; deletions: number };

export function diffStat(files: readonly FileDiffMetadata[]): DiffStat {
  return files.reduce<DiffStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }
      return total;
    },
    { files: files.length, additions: 0, deletions: 0 },
  );
}

export function filePath(file: FileDiffMetadata): string {
  const raw = file.name ?? file.prevName ?? "";
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

export function fileKey(file: FileDiffMetadata): string {
  const key = file.cacheKey;
  if (key === undefined) return `${file.prevName ?? "none"}:${file.name}`;
  return key.endsWith(":hydrated") ? key.slice(0, -":hydrated".length) : key;
}
