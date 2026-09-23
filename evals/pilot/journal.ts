/** Fixed legacy pilot journal. Its schema, budgets and task identities are unchanged. */
import { createJournalScope } from "../core/request-journal.js";
import { PILOT_LIMITS, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
export { PilotJournalError } from "../core/request-journal.js";
export type { PilotJournalMode, PilotJournalIndex } from "../core/request-journal.js";
export type PilotReserveSnapshot = import("../core/request-journal.js").PilotReserveSnapshot<PilotTaskId>;
export type PilotSettleSnapshot = import("../core/request-journal.js").PilotSettleSnapshot<PilotTaskId>;
export type PilotReserveEvent = import("../core/request-journal.js").PilotReserveEvent<PilotTaskId>;
export type PilotSettleEvent = import("../core/request-journal.js").PilotSettleEvent<PilotTaskId>;
export type PilotJournalSummary = import("../core/request-journal.js").PilotJournalSummary<PilotTaskId>;
export type PilotJournalRecovery = import("../core/request-journal.js").PilotJournalRecovery<PilotTaskId>;
const scope = createJournalScope({ namespace: "pilot", taskIds: PILOT_TASK_IDS, limits: PILOT_LIMITS });
export const createPilotJournal = scope.create;
export const recoverPilotJournal = scope.recover;
