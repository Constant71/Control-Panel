import type { Snapshot, ProbeView, FetchError } from "../server/poller";
import type { RateState } from "../server/rateLimiter";
import type { ApiLogEntry, Schemas } from "../server/gameClient";

export type { Snapshot, ProbeView, FetchError, RateState, ApiLogEntry, Schemas };
export type { Problem, FixOption, FixLogEntry, FixAttemptState, AutoFixMode, Discovery, SectorScanInfo } from "../shared/problems";
import type { Problem, AutoFixMode } from "../shared/problems";
export interface PanelState {
  snapshot: Snapshot;
  rate: RateState;
  fixMode: AutoFixMode;
  problems: Problem[];
  unreadDiscoveries: number;
  automationMode: AutoFixMode;
  readySuggestions?: number;
  orders?: Record<string, PanelOrder>;
  planned?: Array<{ probeId: number | null; mannyId: string | null; label: string; why: string }>;
}
import type { PanelOrder } from "../shared/activity";
export type { AutomationSettings, AutomationAction, AutomationLogEntry, PlannedRename, ProbeAutomationSettings, ProbeRole } from "../shared/automation";
