export interface RunScope {
	projectId: string;
	sessionId: string;
	runId: string;
	generation: number;
	role: string | null;
}

export type TraceSummaryValue = string | number | boolean | null;

export interface TraceEvent {
	schemaVersion: 1;
	caseId: string;
	scope: RunScope;
	sequence: number;
	timestampMs: number;
	event: string;
	summary: Record<string, TraceSummaryValue>;
}
