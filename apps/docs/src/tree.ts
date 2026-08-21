import fs from "node:fs";
import path from "node:path";

export type Doc = { kind: "doc"; title: string; slug: string; file: string };
export type Folder = { kind: "folder"; title: string; slug: string; children: Entry[] };
export type Entry = Doc | Folder;

/** A leading number orders an entry in the sidebar and never reaches the url or the title. */
const ORDER = /^\d+[-_]/;

export function read(dir: string, parent = ""): Entry[] {
  if (!fs.existsSync(dir)) return [];
  const entries: Entry[] = [];
  for (const found of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
    const file = path.join(dir, found.name);
    const slug = join(parent, found.name);
    if (found.isDirectory()) {
      entries.push({ kind: "folder", title: label(found.name), slug, children: read(file, slug) });
      continue;
    }
    if (!found.name.endsWith(".html")) continue;
    entries.push({ kind: "doc", title: titleOf(file, label(found.name)), slug, file });
  }
  return entries;
}

export function find(entries: Entry[], slug: string): Doc | undefined {
  for (const entry of entries) {
    if (entry.kind === "doc") {
      if (entry.slug === slug) return entry;
      continue;
    }
    const inside = find(entry.children, slug);
    if (inside !== undefined) return inside;
  }
  return undefined;
}

/** Every doc in sidebar order, which is the order a reader walks them. */
export function docs(entries: Entry[]): Doc[] {
  return entries.flatMap((entry) => (entry.kind === "doc" ? [entry] : docs(entry.children)));
}

function byName(a: fs.Dirent, b: fs.Dirent): number {
  return a.name.localeCompare(b.name);
}

function join(parent: string, name: string): string {
  const own = name.replace(ORDER, "").replace(/\.html$/, "");
  if (own === "index") return parent;
  return parent === "" ? own : `${parent}/${own}`;
}

function label(name: string): string {
  const words = name.replace(ORDER, "").replace(/\.html$/, "").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function titleOf(file: string, fallback: string): string {
  const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(fs.readFileSync(file, "utf8"));
  const title = found?.[1]?.trim();
  return title === undefined || title === "" ? fallback : title;
}

/** Docs are whole html pages, so they open on their own too. Only the body belongs in the shell. */
export function bodyOf(html: string): string {
  const found = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return found?.[1] ?? html;
}
