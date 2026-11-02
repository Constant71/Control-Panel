/** Exploration status shown on the Map page (step 3c). */
export interface ExploreCandidate {
  target: { x: number; y: number; z: number };
  score: number;
  notes: string[];
  safe: boolean;
}

export interface ExploreStatus {
  probeId: number;
  probeName: string;
  state: "dwelling" | "recalling" | "moving" | "needs_you" | "blocked" | "waiting";
  text: string;
  candidates: ExploreCandidate[];
}
