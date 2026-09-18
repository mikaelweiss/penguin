import fs from "node:fs";
import type { Ctx } from "penguin";
import { z } from "zod";
import { narrated } from "./turns.ts";

/** Two more passes at the renderer's complaints, then the workflow carries on without a page. */
const RETRIES = 2;

const NO_NOTES = "no notes, all approved";

const HEADER = "## Notes from";

const FENCE = /^(-{3,}|`{3,})$/;

/** The page writes each answered row as a markdown list item. A row without one reads the same. */
const BULLET = /^[-*]\s+/;

/** The pages the renderer writes beside the JSON. */
const PAGES = [".html", ".md", ".png"];

export type Page = { json: string; html: string; md: string; png: string | null };

export type BriefOptions = {
  /** What the brief covers: the plan text, or the base and the verdict. */
  about: string;
  /** The reply the person sent back, which this render answers. */
  notes?: string;
  /** A scope of its own, a pull request's number, when the checkout is not the subject. */
  branch?: string;
};

export const NOTES_ASK =
  "The proposal is open in the browser. Tick, pick, or annotate it, press Copy notes, and paste the block here. approve takes the page as it stands, and anything else you type goes back as a revision.";

/** The answer NOTES_ASK takes: the word that approves, or the revision in the person's own words. */
export const Notes = z.union([z.enum(["approve"]), z.string()]);

function ask(mode: string, json: string, options: BriefOptions): string {
  const parts = [
    `# The brief\n\nWrite the ${mode} brief as JSON at ${json} and stop there. penguin renders the page and sends back anything the renderer refuses.`,
    `# What it covers\n\n${options.about}`,
  ];
  if (fs.existsSync(json)) {
    parts.push(
      `# The numbers stand\n\n${json} holds the brief this replaces. Every behavior it lists keeps the number it has, and anything new goes on the end.`,
    );
  }
  const notes = options.notes?.trim() ?? "";
  if (notes !== "") {
    parts.push(
      `# The reply this answers\n\nPut the whole reply into the brief's \`notes\` field word for word, and make the changes it asks for.\n\n${notes}`,
    );
  }
  return parts.join("\n\n");
}

function listed(problems: string[]): string {
  return problems.map((one) => `- ${one}`).join("\n");
}

function refused(json: string, problems: string[]): string {
  return `# The renderer refused the brief\n\nNothing rendered. Fix every line in ${json} and stop there, and penguin renders it again.\n\n${listed(problems)}`;
}

/** A render that never happens must not leave the brief before it standing in for this one. */
function clear(json: string): void {
  for (const ext of PAGES) fs.rmSync(json.replace(/\.json$/, ext), { force: true });
}

async function write(
  ctx: Ctx<unknown>,
  session: string,
  mode: string,
  options: BriefOptions,
): Promise<Page | null> {
  const { agent, brief, view } = ctx;
  const json = await brief.where({ name: mode, branch: options.branch });
  clear(json);
  let prompt = ask(mode, json, options);
  let problems: string[] = [];
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    await narrated(view, () => agent.turn(session, { skill: "brief", prompt }));
    const rendered = await brief.render(json);
    if (rendered.problems.length === 0) {
      await brief.open(rendered.html, rendered.version);
      return { json, html: rendered.html, md: rendered.md, png: rendered.png };
    }
    problems = rendered.problems;
    prompt = refused(json, problems);
  }
  await view.show(`The ${mode} brief did not render:\n\n${listed(problems)}`);
  return null;
}

export function proposal(
  ctx: Ctx<unknown>,
  session: string,
  options: BriefOptions,
): Promise<Page | null> {
  return write(ctx, session, "proposal", options);
}

export function reviewBrief(
  ctx: Ctx<unknown>,
  session: string,
  options: BriefOptions,
): Promise<Page | null> {
  return write(ctx, session, "review", options);
}

/** Everything the answer says beyond the block the page wrote for it. */
function remaining(answer: string): string[] {
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !FENCE.test(line) &&
        !line.startsWith(HEADER) &&
        line.toLowerCase() !== NO_NOTES,
    );
}

/** The page's own copy, which a free-typed revision never has. */
function copied(answer: string): boolean {
  return answer.split("\n").some((line) => {
    const said = line.trim();
    return said.startsWith(HEADER) || said.toLowerCase() === NO_NOTES;
  });
}

/** A row the person left as the page wrote it: a number with nothing said about it. */
function untouched(row: string): boolean {
  const said = row.replace(BULLET, "");
  const numbered = /^\d+[.)]?\s*(.*)$/.exec(said);
  if (numbered !== null) {
    const answer = (numbered[1] ?? "").trim().toLowerCase();
    return answer === "" || answer === "ok";
  }
  const other = /^other\s*:\s*(.*)$/i.exec(said);
  return other !== null && (other[1] ?? "").trim() === "";
}

export function notesApprove(answer: string): boolean {
  if (answer.trim().toLowerCase() === "approve") return true;
  if (!copied(answer)) return false;
  return remaining(answer).every(untouched);
}

export function notesRevision(answer: string): string {
  return remaining(answer).join("\n");
}
