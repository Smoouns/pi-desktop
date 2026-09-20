import type { RunScope, TraceEvent, TraceSummaryValue } from "./types.js";

export interface TraceRecorderOptions {
	caseId: string;
	scope: RunScope;
	now?: () => number;
}

export interface TraceRecorder {
	record(event: string, summary?: Record<string, TraceSummaryValue>): TraceEvent;
	snapshot(): TraceEvent[];
}

function normalizeSummary(
	summary: Record<string, TraceSummaryValue> = {},
): Record<string, TraceSummaryValue> {
	const normalized: Record<string, TraceSummaryValue> = {};
	for (const key of Object.keys(summary).sort()) {
		const value = summary[key];
		if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
			throw new TypeError(`Trace summary field ${key} must be a scalar`);
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError(`Trace summary field ${key} must be finite`);
		}
		normalized[key] = value;
	}
	return normalized;
}

export function createTraceRecorder(options: TraceRecorderOptions): TraceRecorder {
	const caseId = options.caseId.trim();
	if (!caseId) throw new TypeError("Trace caseId must not be empty");
	const now = options.now ?? Date.now;
	const scope = { ...options.scope };
	const events: TraceEvent[] = [];

	return {
		record(event, summary = {}) {
			const eventName = event.trim();
			if (!eventName) throw new TypeError("Trace event must not be empty");
			const timestampMs = now();
			if (!Number.isFinite(timestampMs)) throw new TypeError("Trace timestamp must be finite");
			const traceEvent: TraceEvent = {
				schemaVersion: 1,
				caseId,
				scope: { ...scope },
				sequence: events.length + 1,
				timestampMs,
				event: eventName,
				summary: normalizeSummary(summary),
			};
			events.push(traceEvent);
			return { ...traceEvent, scope: { ...traceEvent.scope }, summary: { ...traceEvent.summary } };
		},
		snapshot() {
			return events.map((item) => ({
				...item,
				scope: { ...item.scope },
				summary: { ...item.summary },
			}));
		},
	};
}
