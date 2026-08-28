const NEUTRAL_MODELS = ["best", "big", "small"] as const;

export type NeutralModel = (typeof NEUTRAL_MODELS)[number];
export type ModelMap = Readonly<Record<NeutralModel, string>>;

function isNeutralModel(model: string): model is NeutralModel {
  return NEUTRAL_MODELS.some((choice) => choice === model);
}

/**
 * Turns a workflow's neutral choice into the model name one agent CLI understands.
 * An unmapped choice returns undefined, so the adapter falls back to its default model.
 */
export function modelFor(
  requested: string | undefined,
  adapter: string,
  defaults: Partial<ModelMap>,
  config: (key: string) => string | undefined,
): string | undefined {
  if (requested === undefined || !isNeutralModel(requested)) return requested;
  const key = `${adapter}-${requested}-model`;
  const configured = config(key)?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return defaults[requested];
}
