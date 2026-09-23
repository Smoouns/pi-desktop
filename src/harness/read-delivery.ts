import type { SourceVersionRef } from "./source-version.js";

export interface ReadDeliverySpan {
	source: SourceVersionRef;
	/** UTF-16, half-open payload offsets. One unit per line, or one atomic excerpt. */
	units: Array<[number, number]>;
	atomic: boolean;
}

/** Process-local, bounded delivery coverage. No file reads and no authority inference. */
export function createReadDelivery(options: { maxRecords?: number; maxUnits?: number } = {}) {
	type Interval = [number, number];
	type Record = { total: number; spans: ReadDeliverySpan[]; identity: string; generation: string; seen: Interval[] };
	const maxRecords = options.maxRecords ?? 512, maxUnits = options.maxUnits ?? 262_144;
	if (![maxRecords, maxUnits].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("Invalid delivery capacity");
	const records = new Map<string, Record>();
	let unitCount = 0;
	const span = (source: SourceVersionRef, text: string, start: number, atomic = false): ReadDeliverySpan => {
		if (!Number.isSafeInteger(start) || start < 0 || typeof text !== "string" || !Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine) || source.startLine! < 1 || source.endLine! < source.startLine!) throw new Error("Invalid delivery range");
		if (atomic) return { source: { ...source }, units: [[start, start + text.length]], atomic };
		const count = source.endLine! - source.startLine! + 1;
		if (count > maxUnits) throw new Error("Delivery mapping capacity reached; read a smaller range");
		const lines = text.split("\n");
		if (lines.length < count || lines.length > count + 1 || (lines.length === count + 1 && lines[count] !== "")) throw new Error("Source text does not match delivery range");
		const units: Interval[] = [];
		let offset = start;
		for (let index = 0; index < count; index++) { const end = offset + lines[index]!.length; units.push([offset, end]); offset = end + 1; }
		return { source: { ...source }, units, atomic };
	};
	const merge = (intervals: Interval[]): Interval[] => {
		const result: Interval[] = [];
		for (const interval of intervals.slice().sort((a, b) => a[0] - b[0])) {
			const last = result.at(-1);
			if (last && last[1] >= interval[0]) last[1] = Math.max(last[1], interval[1]);
			else result.push([...interval]);
		}
		return result;
	};
	const refs = (record: Record, intervals: Interval[]): SourceVersionRef[] => {
		const output: SourceVersionRef[] = [];
		for (const item of record.spans) {
			let first = -1;
			const flush = (end: number) => { if (first >= 0) output.push({ ...item.source, startLine: item.source.startLine! + first, endLine: item.source.startLine! + end }); first = -1; };
			for (let index = 0; index < item.units.length; index++) {
				const [start, end] = item.units[index]!;
				const covered = intervals.some(([left, right]) => left <= start && right >= end);
				if (item.atomic) { if (covered) output.push({ ...item.source }); break; }
				if (covered) { if (first < 0) first = index; }
				else flush(index - 1);
			}
			if (!item.atomic) flush(item.units.length - 1);
		}
		return output;
	};
	return {
		span,
		register(id: string, total: number, spans: ReadDeliverySpan[]) {
			if (!id || !Number.isSafeInteger(total) || total < 0 || spans.length > 32) throw new Error("Invalid delivery mapping");
			const identity = JSON.stringify([total, spans]), existing = records.get(id);
			if (existing) { if (existing.identity !== identity) throw new Error("Delivery identity collision"); return; }
			const count = spans.reduce((n, item) => n + item.units.length, 0);
			if (records.size >= maxRecords || count > maxUnits - unitCount) throw new Error("Delivery mapping capacity reached; read a smaller range");
			for (const item of spans) for (const [start, end] of item.units) if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > total) throw new Error("Delivery mapping exceeds payload bounds");
			records.set(id, { total, spans: spans.map((item) => ({ source: { ...item.source }, units: item.units.map(([a, b]) => [a, b]), atomic: item.atomic })), identity, generation: "", seen: [] });
			unitCount += count;
		},
		deliver(id: string, generation: string, start: number, end: number) {
			const record = records.get(id);
			if (!record) throw new Error("Delivery mapping unavailable; reread the source");
			if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > record.total) throw new Error("Delivery page exceeds payload bounds");
			const current: Interval[] = [[start, end]];
			const seen = merge([...(record.generation === generation ? record.seen : []), ...current]);
			if (seen.length > 256) throw new Error("Delivery page capacity reached; use a contiguous range");
			record.seen = seen; record.generation = generation;
			return { schemaVersion: 1 as const, sourceRefs: refs(record, seen), deliveredSourceRefs: refs(record, current), start, end, totalChars: record.total, hasMore: end < record.total };
		},
		forgetCoverage(id: string) { const record = records.get(id); if (record) record.seen = []; },
	};
}
