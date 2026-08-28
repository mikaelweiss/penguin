import { PenguinError } from "penguin";

const NEUTRAL_MODELS = ["best", "big", "small"] as const;

export type NeutralModel = (typeof NEUTRAL_MODELS)[number];
export type ModelMap = Readonly<Record<NeutralModel, string>>;

function isNeutralModel(model: string): model is NeutralModel {
  return NEUTRAL_MODELS.some((choice) => choice === model);
}

/** Turns a workflow's neutral choice into the model name one agent CLI understands. */
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
  const model = defaults[requested];
  if (model !== undefined) return model;
  throw new PenguinError(
    `the ${adapter} adapter cannot map model ${requested}; set ${key} in ~/.penguin/config or pass an exact model name`,
  );
}
