export { adapter } from "./adapter.ts";
export { workflow } from "./workflow.ts";
export { PenguinError, messageOf } from "./errors.ts";
export type {
  Adapters,
  AgentFactory,
  AgentOptions,
  AgentRunOptions,
  AgentSession,
  Ctx,
  Turn,
  Workflow,
  WorkflowDefinition,
} from "./ctx.ts";
export type {
  Adapter,
  AgentAdapter,
  AgentTurn,
  AgentTurnResult,
  CommandResult,
  CredentialField,
  CredentialRequest,
  ExecOptions,
  Host,
  Message,
  Messages,
  ShellOptions,
  View,
  ViewEvent,
} from "./types.ts";

export * as catalogs from "./catalog/catalogs.ts";
export {
  type Catalog,
  adaptersDir,
  forScope,
  homeCatalog,
  projectCatalog,
  roots as catalogRoots,
  skillsDir,
  starterCatalog,
} from "./catalog/catalogs.ts";
export {
  type Found as AdapterFound,
  type Picked,
  defaults,
  installed,
  installedIn,
  loadAdapter,
  pick,
  renderEnv,
  searched as searchedAdapters,
  writeEnv,
} from "./catalog/adapters.ts";
export {
  type Details,
  type Found as WorkflowFound,
  choices,
  found as foundWorkflows,
  foundIn,
  listed,
  locate,
  searched as searchedWorkflows,
} from "./catalog/workflows.ts";
export {
  type Root as SkillRoot,
  type Skill,
  type Source as SkillSource,
  available as availableSkills,
  link as linkSkills,
  resolve as resolveSkill,
  roots as skillRoots,
  searchPath,
  searchPathIn,
  shared as sharedSkills,
  sources as skillSources,
} from "./catalog/skills.ts";
export { importDefault, load, register } from "./catalog/loader.ts";
export {
  type Asked,
  type ParamsSchema,
  coerce,
  parseParams,
  unfilled,
  usage,
  validate,
} from "./catalog/params.ts";

export { execute } from "./execute.ts";
export { allocateRun, createRun, discardRun, finishRun, readRun, type RunRecord } from "./create.ts";
export { startRun } from "./start.ts";
export { acquire, alive, holder } from "./lock.ts";
export { Tail } from "./follow.ts";
export * as credentials from "./credentials.ts";
export { type RunOnDisk, type LiveRow, liveRows, rows, runRows } from "./runs.ts";
export {
  type Scope,
  attachmentsDir,
  catalogsFile,
  credentialFile,
  credentialsDir,
  defaultsFile,
  envFile,
  eventsPath,
  home,
  inboxPath,
  projectHome,
  runDir,
  runJsonPath,
  runsRoot,
  short,
  stateRoot,
  transcriptsDir,
  userRoot,
} from "./paths.ts";
