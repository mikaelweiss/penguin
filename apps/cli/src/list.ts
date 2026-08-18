import { type LiveRow, short, type Skill, type WorkflowFound } from "@mikaelweiss/penguin-engine";
import { blocks, table } from "./layout.ts";

export function workflowBlocks(list: WorkflowFound[], verbose = false): string {
  return blocks(
    list.map((entry) => ({
      name: entry.name,
      tokens: entry.params,
      description: entry.description,
      meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
    })),
  );
}

export function skillBlocks(list: Skill[], verbose = false): string {
  return blocks(
    list.map((skill) => ({
      name: skill.name,
      tokens: [],
      description: skill.description,
      meta: verbose ? `${skill.scope}  ${skill.source}  ${short(skill.at)}` : "",
    })),
  );
}

export function adapterBlocks(
  list: { role: string; name: string; description: string; scope: string; file: string }[],
  verbose = false,
): string {
  return blocks(
    list.map((entry) => ({
      name: entry.role,
      tokens: [entry.name],
      description: entry.description,
      meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
    })),
  );
}

/** The piped `pn ps` table: live runs, one row each. */
export function liveRunTable(list: LiveRow[]): string {
  const columns: (keyof LiveRow)[] = ["run", "workflow", "state", "detail", "age", "dir"];
  const header = ["RUN", "WORKFLOW", "STATE", "DETAIL", "AGE", "DIRECTORY"];
  return table([header, ...list.map((entry) => columns.map((column) => entry[column]))]);
}
