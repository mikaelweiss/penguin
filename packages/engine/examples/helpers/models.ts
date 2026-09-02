const NEUTRAL_MODELS = ["small", "normal", "big"] as const;

export type NeutralModel = (typeof NEUTRAL_MODELS)[number];
export type ModelMap = Readonly<Record<NeutralModel, string>>;

function isNeutralModel(model: string): model is NeutralModel {
  return NEUTRAL_MODELS.some((choice) => choice === model);
}

/** The model name one agent CLI understands for a workflow's neutral tier. */
export function modelFor(
  requested: string | undefined,
  adapter: string,
  defaults: Partial<ModelMap>,
  config: (key: string) => string | undefined,
): string | undefined {
  const wanted = requested ?? "normal";
  if (!isNeutralModel(wanted)) return wanted;
  const key = `${adapter}-${wanted}-model`;
  const configured = config(key)?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return defaults[wanted];
}

/** Reviews run on a CLI other than the one that wrote the change, for a second opinion. */
export const REVIEWER = "cursor";
