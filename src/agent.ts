import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runAgent } from "./spawn.ts";

export type AgentStep = {
  command: string;
  skill: string;
  skillText: string;
  input: string | undefined;
  result: z.ZodObject | undefined;
  cwd: string;
  transcript: string;
  failure: string | undefined;
};

export type Attempt = { ok: true; value: unknown } | { ok: false; error: string };

export async function attempt(step: AgentStep): Promise<Attempt> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-step-"));
  const resultPath = path.join(dir, "result.json");
  try {
    const code = await runAgent(step.command, step.cwd, prompt(step, resultPath), step.transcript);
    if (code !== 0) return { ok: false, error: `the agent exited with code ${code}` };
    if (step.result === undefined) return { ok: true, value: null };
    if (!fs.existsSync(resultPath)) {
      return { ok: false, error: `the agent wrote no result to ${resultPath}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch {
      return { ok: false, error: "the result is not valid JSON" };
    }
    const checked = step.result.safeParse(parsed);
    if (!checked.success) return { ok: false, error: issues(checked.error) };
    return { ok: true, value: checked.data };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function prompt(step: AgentStep, resultPath: string): string {
  const parts = [step.skillText.trim()];
  if (step.input !== undefined && step.input !== "") {
    parts.push(`# Input\n\n${step.input}`);
  }
  if (step.result !== undefined) {
    const schema = JSON.stringify(z.toJSONSchema(step.result), undefined, 2);
    parts.push(
      `# Result\n\nWrite your result to ${resultPath} as JSON.\nThe JSON must match this schema:\n\n\`\`\`json\n${schema}\n\`\`\``,
    );
  }
  if (step.failure !== undefined) {
    parts.push(`# Correction\n\nThe last attempt failed: ${step.failure}\nDo the step again and fix that.`);
  }
  return `${parts.join("\n\n")}\n`;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.join(".");
      return at === "" ? issue.message : `${at}: ${issue.message}`;
    })
    .join("; ");
}
