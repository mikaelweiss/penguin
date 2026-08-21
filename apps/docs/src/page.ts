import type { Doc, Entry } from "./tree.ts";

const ICON = "size-4 shrink-0 fill-zinc-500 dark:fill-zinc-400";

const BARS =
  "M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm0 3.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z";

const CLOSE =
  "M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z";

const LEFT =
  "M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z";

const RIGHT =
  "M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06L7.28 11.78a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z";

export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function icon(path: string, rule = false): string {
  const clipped = rule ? ' fill-rule="evenodd" clip-rule="evenodd"' : "";
  return `<svg viewBox="0 0 16 16" aria-hidden="true" class="${ICON}"><path d="${path}"${clipped} /></svg>`;
}

function wordmark(): string {
  return `<a href="/" class="flex items-baseline gap-x-2">
    <span class="text-lg font-semibold tracking-tight text-zinc-950 dark:text-white">penguin</span>
    <span class="text-sm text-teal-700 dark:text-teal-400">docs</span>
  </a>`;
}

function link(doc: Doc, current: string): string {
  const active = doc.slug === current;
  const tone = active
    ? "bg-zinc-950/5 text-zinc-950 dark:bg-white/10 dark:text-white"
    : "text-zinc-600 hover:bg-zinc-950/5 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-white";
  const here = active ? ' aria-current="page"' : "";
  return `<li class="text-base/6 sm:text-sm/6">
    <a href="/${doc.slug}"${here} class="block rounded-md px-3 py-2 sm:py-1.5 ${tone}">${escape(doc.title)}</a>
  </li>`;
}

function branch(entries: Entry[], current: string): string {
  const docs = entries.filter((entry): entry is Doc => entry.kind === "doc");
  const list =
    docs.length === 0
      ? ""
      : `<ul role="list" class="flex flex-col gap-y-0.5">${docs.map((doc) => link(doc, current)).join("")}</ul>`;
  const folders = entries
    .filter((entry) => entry.kind === "folder")
    .map(
      (folder) => `<div>
        <div class="px-3 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">${escape(folder.title)}</div>
        <div class="mt-2 border-l border-zinc-950/5 pl-2 dark:border-white/10">${branch(folder.children, current)}</div>
      </div>`,
    )
    .join("");
  return `<div class="flex flex-col gap-y-6">${list}${folders}</div>`;
}

function step(doc: Doc | undefined, side: "previous" | "next"): string {
  if (doc === undefined) return "<div></div>";
  const arrow = side === "previous" ? icon(LEFT, true) : icon(RIGHT, true);
  const order = side === "previous" ? "" : "flex-row-reverse text-right";
  return `<a href="/${doc.slug}" class="group flex flex-col gap-y-1 rounded-lg px-4 py-3 hover:bg-zinc-950/2.5 dark:hover:bg-white/5">
    <div class="text-sm/6 text-zinc-500 dark:text-zinc-400">${side === "previous" ? "Previous" : "Next"}</div>
    <div class="flex items-center gap-x-2 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white ${order}">
      ${arrow}<span>${escape(doc.title)}</span>
    </div>
  </a>`;
}

export function shell(options: {
  entries: Entry[];
  doc: Doc;
  section: string;
  body: string;
  previous?: Doc;
  next?: Doc;
}): string {
  const nav = branch(options.entries, options.doc.slug);
  const eyebrow =
    options.section === ""
      ? ""
      : `<div class="text-base/6 font-medium text-teal-700 sm:text-sm/6 dark:text-teal-400">${escape(options.section)}</div>`;
  return `<!doctype html>
<html lang="en" class="scheme-light-dark antialiased">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(options.doc.title)} — penguin docs</title>
    <link rel="preconnect" href="https://rsms.me/" crossorigin />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="isolate bg-white dark:bg-zinc-950">
    <header class="sticky top-0 z-30 flex items-center justify-between border-b border-zinc-950/5 bg-white/90 px-6 py-4 backdrop-blur-sm lg:hidden dark:border-white/10 dark:bg-zinc-950/90">
      ${wordmark()}
      <button type="button" id="open-menu" aria-label="Open navigation" class="rounded-md p-2 hover:bg-zinc-950/5 dark:hover:bg-white/5">
        ${icon(BARS)}
      </button>
    </header>

    <div class="fixed inset-y-0 left-0 z-40 w-72 overflow-y-auto border-r border-zinc-950/5 px-6 py-8 max-lg:hidden dark:border-white/10">
      ${wordmark()}
      <nav class="mt-8">${nav}</nav>
    </div>

    <dialog id="menu" class="m-0 h-dvh max-h-dvh w-72 max-w-[80vw] bg-white p-0 backdrop:bg-zinc-950/40 lg:hidden dark:bg-zinc-950">
      <div class="flex h-full flex-col overflow-y-auto px-6 py-6">
        <div class="flex items-center justify-between">
          ${wordmark()}
          <button type="button" id="close-menu" aria-label="Close navigation" class="rounded-md p-2 hover:bg-zinc-950/5 dark:hover:bg-white/5">
            ${icon(CLOSE)}
          </button>
        </div>
        <nav class="mt-8">${nav}</nav>
      </div>
    </dialog>

    <main class="lg:pl-72">
      <div class="mx-auto max-w-3xl px-6 py-10 lg:px-16 lg:py-16">
        ${eyebrow}
        <div class="prose mt-2 max-w-[72ch]">${options.body}</div>
        <div class="mt-16 grid grid-cols-2 gap-x-4 border-t border-zinc-950/5 pt-6 dark:border-white/10">
          ${step(options.previous, "previous")}${step(options.next, "next")}
        </div>
      </div>
    </main>

    <script>
      const menu = document.getElementById("menu");
      document.getElementById("open-menu").addEventListener("click", () => menu.showModal());
      document.getElementById("close-menu").addEventListener("click", () => menu.close());
      matchMedia("(min-width: 64rem)").addEventListener("change", (event) => {
        if (event.matches) menu.close();
      });
    </script>
  </body>
</html>
`;
}

export function missing(entries: Entry[], slug: string): string {
  const body = `<h1>Not a page here</h1>
    <p>Nothing in the docs folder answers to <code>/${escape(slug)}</code>. The sidebar has everything that does.</p>`;
  return shell({
    entries,
    doc: { kind: "doc", title: "Not found", slug, file: "" },
    section: "",
    body,
  });
}
