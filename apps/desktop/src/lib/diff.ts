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

/** Two hashes plus the length, so the renderer never reuses one file's tokens. */
export function diffCacheKey(text: string): string {
  const first = fnv1a32(text, FNV_OFFSET, FNV_PRIME).toString(36);
  const second = fnv1a32(text, SECOND_SEED, SECOND_PRIME).toString(36);
  return `diff:${text.length}:${first}:${second}`;
}

/** The one file a single-file patch describes, or undefined when it will not parse. */
export function parseFileDiff(file: string, patch: string): FileDiffMetadata | undefined {
  const text = patch.trim();
  if (text === "") return undefined;

  try {
    const parsed = parsePatchFiles(text, diffCacheKey(`${file}\n${text}`));
    return parsed.flatMap((one) => one.files)[0];
  } catch {
    return undefined;
  }
}
