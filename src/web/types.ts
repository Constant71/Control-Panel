import type { Snapshot, ProbeView, FetchError } from "../server/poller";
import type { RateState } from "../server/rateLimiter";
import type { ApiLogEntry, Schemas } from "../server/gameClient";

export type { Snapshot, ProbeView, FetchError, RateState, ApiLogEntry, Schemas };
export interface PanelState {
  snapshot: Snapshot;
  rate: RateState;
}
