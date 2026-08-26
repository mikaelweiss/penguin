export { PenguinError, messageOf } from "../core/errors.ts";
export { readConfig } from "../config.ts";
export { catalogsFile, configFile, home, projectHome, runsDir } from "../paths.ts";

export {
  adaptersDir,
  builtinCatalog,
  homeCatalog,
  projectCatalog,
  roots,
  skillsDir,
  starterCatalog,
  workflowsDir,
  worktreeCatalogs,
  type Catalog,
  type CatalogScope,
} from "./catalogs.ts";

export {
  installed,
  installedIn,
  loadAdapter,
  pick,
  searchedAdapters,
  type AdapterFound,
  type Picked,
} from "./adapters.ts";

export { found, locate, searchedWorkflows, type WorkflowFound } from "./workflows.ts";

export {
  foundSkills,
  locateSkill,
  readSkill,
  searchedSkills,
  skillLookup,
  skillsIn,
  type SkillFound,
} from "./skills.ts";

export { load } from "./loader.ts";

export { writeEditorFiles } from "./editor.ts";
