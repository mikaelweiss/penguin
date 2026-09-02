const NEUTRAL_MODELS = ["best", "big", "small"] as const;

export type NeutralModel = (typeof NEUTRAL_MODELS)[number];
export type ModelMap = Readonly<Record<NeutralModel, string>>;

function isNeutralModel(model: string): model is NeutralModel {
  return NEUTRAL_MODELS.some((choice) => choice === model);
}

/**
 * Turns a workflow's neutral choice into the model name one agent CLI understands.
 * A session that names no model runs on best, so a bare open is the strongest model and
 * a workflow spells out only the turns that take less. An unmapped choice returns
 * undefined, so the adapter falls back to its default model.
 */
export function modelFor(
  requested: string | undefined,
  adapter: string,
  defaults: Partial<ModelMap>,
  config: (key: string) => string | undefined,
): string | undefined {
  const wanted = requested ?? "best";
  if (!isNeutralModel(wanted)) return wanted;
  const key = `${adapter}-${wanted}-model`;
  const configured = config(key)?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return defaults[wanted];
}
