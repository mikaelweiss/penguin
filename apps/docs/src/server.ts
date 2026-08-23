import fs from "node:fs";
import path from "node:path";
import { missing, shell } from "./page.ts";
import { bodyOf, docs, find, read, type Entry } from "./tree.ts";

const root = path.resolve(
  process.env["PENGUIN_DOCS_DIR"] ?? path.join(import.meta.dir, "../../../docs"),
);
const assets = path.join(import.meta.dir, "../public");
const port = Number(process.env["PORT"] ?? 5656);

if (!fs.existsSync(root)) {
  process.stderr.write(`penguin-docs: no docs folder at ${root}\n`);
  process.exit(1);
}

/** The folder a doc sits in, for the line above its title. */
function sectionOf(entries: Entry[], slug: string, name = ""): string {
  for (const entry of entries) {
    if (entry.kind === "doc") {
      if (entry.slug === slug) return name;
      continue;
    }
    const inside = sectionOf(entry.children, slug, entry.title);
    if (inside !== "") return inside;
  }
  return "";
}

function file(dir: string, url: string): string | undefined {
  const target = path.resolve(dir, `.${url}`);
  if (!target.startsWith(`${dir}${path.sep}`)) return undefined;
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : undefined;
}

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const asset = file(assets, url.pathname);
    if (asset !== undefined) return new Response(Bun.file(asset));

    const entries = read(root);
    const slug = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
    const doc = find(entries, slug);
    if (doc === undefined) {
      const media = url.pathname.endsWith(".html") ? undefined : file(root, url.pathname);
      if (media !== undefined) return new Response(Bun.file(media));
      return new Response(missing(entries, slug), {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const html = fs.readFileSync(doc.file, "utf8");
    if (/<meta\s+name="penguin-docs"\s+content="standalone"/.test(html)) {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const order = docs(entries);
    const at = order.findIndex((entry) => entry.slug === doc.slug);
    return new Response(
      shell({
        entries,
        doc,
        section: sectionOf(entries, doc.slug),
        body: bodyOf(html),
        previous: order[at - 1],
        next: order[at + 1],
      }),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});

process.stdout.write(`penguin docs: ${server.url}\nreading ${root}\n`);
