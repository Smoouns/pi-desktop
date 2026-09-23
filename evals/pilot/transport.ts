/** Legacy pilot policy stays fixed; S2 uses an independent policy and identity. */
import { createBoundedTransport, type RequestSnapshot, type TransportSnapshot, type TransportOptions, type RequestStopCode } from "../core/request-transport.js";
import { PILOT_LIMITS, PILOT_TASK_IDS, type PilotTaskId } from "./policy.js";
export const PILOT_TRANSPORT_LIMITS = PILOT_LIMITS;
export type PilotStopCode = RequestStopCode;
export type PilotRequestSnapshot = RequestSnapshot<PilotTaskId>;
export type PilotTransportSnapshot = TransportSnapshot<PilotTaskId>;
export type PilotTransportOptions = TransportOptions<PilotTaskId>;
export function createPilotTransport(options: PilotTransportOptions) {
	return createBoundedTransport(options, { namespace: "pilot", taskIds: PILOT_TASK_IDS, limits: PILOT_LIMITS });
}
