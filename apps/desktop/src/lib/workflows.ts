import { invoke } from "@tauri-apps/api/core";

export type Scope = "project" | "home" | "starter" | "catalog" | "builtin";

export type Workflow = {
  name: string;
  scope: Scope;
  file: string;
  description?: string;
  /** The params schema as JSON Schema, what the params form is built from. */
  params?: Record<string, unknown>;
  /** Why the file refused to load, when it did. */
  error?: string;
};

export type Skill = {
  name: string;
  description: string;
  scope: Scope;
  dir: string;
};

export type Adapter = {
  role: string;
  name: string;
  description: string;
  scope: Scope;
  file: string;
};

export type Catalogs = {
  workflows: Workflow[];
  skills: Skill[];
  adapters: Adapter[];
  errors: string[];
};

/** The catalogs one folder can reach, as the engine's describe entry prints them. */
export function describe(dir: string): Promise<Catalogs> {
  return invoke<Catalogs>("describe", { dir });
}

/** A run folder before the run exists, so a pasted file has somewhere to land. */
export function claimRun(): Promise<string> {
  return invoke<string>("claim_run");
}

/** Drops a claimed folder that never became a run. One holding a run file is left alone. */
export function discardRun(id: string): Promise<void> {
  return invoke("discard_run", { id });
}

/** Starts a workflow as its own run and settles with the id its files live under. */
export function startRun(
  file: string,
  params: unknown,
  dir: string,
  id: string | undefined,
): Promise<string> {
  return invoke<string>("start_run", { file, params, dir, id });
}

const ORDER: Scope[] = ["project", "home", "catalog", "starter", "builtin"];

const TITLES: Record<Scope, string> = {
  project: "project",
  home: "home",
  catalog: "catalogs",
  starter: "starter",
  builtin: "builtin",
};

export type Shelf = {
  scope: Scope;
  title: string;
  workflows: Workflow[];
};

/** The workflows grouped by catalog, nearest catalog first. */
export function shelves(workflows: Workflow[]): Shelf[] {
  return ORDER.map((scope) => ({
    scope,
    title: TITLES[scope],
    workflows: workflows.filter((workflow) => workflow.scope === scope),
  })).filter((shelf) => shelf.workflows.length > 0);
}
