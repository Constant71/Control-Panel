/** One game API operation, generated from spec/openapi.yaml (see scripts/gen-operations.ts). */
export interface OpParam {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  default?: unknown;
  nullable?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  example?: unknown;
  [extra: string]: unknown;
}

export type Risk = "read" | "normal" | "confirm" | "blocked";

export interface Operation {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: OpParam[];
  body: JsonSchema | null;
  bodyExample: unknown;
  risk: Risk;
  riskNote: string;
}

const CONFIRM: Array<[RegExp, string]> = [
  [/^DELETE /, "Deletes something; it can't be undone."],
  [/\/jettison$/, "Throws the item or resources into space."],
  [/ignite_missile$|\/missiles$/, "Prepares and fires a missile."],
  [/\/trajectories$/, "Launches an asteroid on a trajectory."],
  [/motorize-asteroid$|refuel-motorized-asteroid$|sculpt-duck-asteroid$/, "Uses parts or fuel on an asteroid."],
  [/drop-storage-container$|detach-storage-container$/, "Leaves a storage container behind in space or on a planet."],
  [/assemble-probe$/, "Consumes a full probe kit and two containers; 3-hour exterior task."],
  [/^POST \/api\/probe\/\{probeId\}\/move$/, "Moves the probe; Mannies outside can be left behind."],
  [/mind-snapshot\/reassign$/, "Irreversible: reassigns your mind snapshot to another probe."],
  [/transfer-to-probe$/, "Moves the Manny to another probe for good."],
  [/\/recall$/, "A Manny recalled from far away can end up forgotten."],
  [/drop-manny-cargo$/, "The Manny drops its cargo in space."],
  [/missions\/\{missionId\}\/abandon$/, "Abandons the mission."],
  [/^PATCH \/api\/forum\/posts\/\{postId\}$/, "Moderates a forum post."],
];
const BLOCKED: Array<[RegExp, string]> = [
  [/^POST \/api\/session$/, "Creates a login session: never needed, the panel uses your API key."],
  [/^POST \/api\/me\/api-key$/, "Creates a new API key: do that in the game, not from the panel."],
];

export function classify(id: string, method: string): { risk: Risk; riskNote: string } {
  for (const [re, note] of BLOCKED) if (re.test(id)) return { risk: "blocked", riskNote: note };
  for (const [re, note] of CONFIRM) if (re.test(id)) return { risk: "confirm", riskNote: note };
  return method === "GET" ? { risk: "read", riskNote: "" } : { risk: "normal", riskNote: "" };
}
