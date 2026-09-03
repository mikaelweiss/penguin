const PROTOCOL = "file://";

function trim(input: string): string {
  const slashes = input.replace(/\\/g, "/");
  const relative = slashes.startsWith("./") ? slashes.slice(2) : slashes;
  return relative.replace(/^\/+/, "").replace(/\/+$/, "");
}

function decode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** Root relative, forward slashes, no leading or trailing slash. */
export function normalizePath(input: string): string {
  if (!input.startsWith(PROTOCOL)) return trim(input);
  return trim(decode(input.slice(PROTOCOL.length)));
}

/** The tab id for a path: "file://" plus each segment encoded. */
export function fileTab(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "") return PROTOCOL;
  return PROTOCOL + normalized.split("/").map(encodeURIComponent).join("/");
}

/** The path behind a tab id, or undefined when the tab is not a file tab. */
export function pathFromTab(tab: string): string | undefined {
  if (!tab.startsWith(PROTOCOL)) return undefined;
  return normalizePath(tab);
}

export function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function fileNameOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}
