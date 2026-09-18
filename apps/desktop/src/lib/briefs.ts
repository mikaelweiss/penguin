/**
 * The pages and pictures a run makes, which the engine writes under ~/.penguin/briefs. A run file
 * is not the app's to trust, so a note pointing anywhere else is not a brief and never loads.
 */

/** Where the engine keeps them, under the home folder the app asks the platform for. */
export function briefsRoot(home: string): string {
  return `${home.replace(/\/+$/, "")}/.penguin/briefs/`;
}

function under(path: string, root: string | undefined): boolean {
  if (root === undefined || root === "" || !path.startsWith(root)) return false;
  return !path.split("/").includes("..");
}

/** The html page a run's open note names, when the note points where the engine writes. */
export function briefPage(url: string, root: string | undefined): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") return undefined;
  const path = decodeURIComponent(parsed.pathname);
  return path.endsWith(".html") && under(path, root) ? path : undefined;
}

/** The picture an image note names, when it sits where the engine writes. */
export function briefImage(path: string, root: string | undefined): string | undefined {
  return under(path, root) ? path : undefined;
}
