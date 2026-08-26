// The frontend's catalog reader: `bun describe.ts [cwd]` prints one JSON object,
// so no frontend ever imports a definition file itself.
import { z } from "zod";
import { installedIn } from "./catalog/adapters.ts";
import { roots, type CatalogScope } from "./catalog/catalogs.ts";
import { writeEditorFiles } from "./catalog/editor.ts";
import { load } from "./catalog/loader.ts";
import { skillsIn, type SkillFound } from "./catalog/skills.ts";
import { found, type WorkflowFound } from "./catalog/workflows.ts";
import { messageOf } from "./core/errors.ts";

export type WorkflowDescribed = WorkflowFound & {
  description?: string;
  /** The params schema as JSON Schema, what a frontend renders the form from. */
  params?: Record<string, unknown>;
  /** Why the file refused to load, when it did. */
  error?: string;
};

export type AdapterDescribed = {
  role: string;
  name: string;
  description: string;
  scope: CatalogScope;
  file: string;
};

export type Described = {
  workflows: WorkflowDescribed[];
  skills: SkillFound[];
  adapters: AdapterDescribed[];
  errors: string[];
};

/**
 * Everything the catalogs hold for one folder, as plain JSON. Reading a catalog
 * is also the moment its editor files can be true, so this refreshes them.
 */
export async function describe(cwd: string): Promise<Described> {
  const list = roots(cwd);
  const errors: string[] = [];
  const workflows: WorkflowDescribed[] = [];
  for (const entry of found(cwd)) {
    try {
      const definition = await load(entry.file, list);
      workflows.push({
        ...entry,
        description: definition.description,
        params: z.toJSONSchema(definition.params) as Record<string, unknown>,
      });
    } catch (error) {
      workflows.push({ ...entry, error: messageOf(error) });
    }
  }
  let skills: SkillFound[] = [];
  try {
    skills = skillsIn(list);
  } catch (error) {
    errors.push(messageOf(error));
  }
  let adapters: AdapterDescribed[] = [];
  try {
    adapters = (await installedIn(list)).map(({ role, name, description, scope, file }) => ({
      role,
      name,
      description,
      scope,
      file,
    }));
  } catch (error) {
    errors.push(messageOf(error));
  }
  try {
    await writeEditorFiles(list);
  } catch (error) {
    errors.push(messageOf(error));
  }
  return { workflows, skills, adapters, errors };
}

if (import.meta.main) {
  console.log(JSON.stringify(await describe(process.argv[2] ?? process.cwd())));
}
