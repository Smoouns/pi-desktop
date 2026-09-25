export interface VerificationProgressEvidence {
	mode: string;
	relatedSourcesDigest: string;
	diagnostics: Record<string, number>;
}

/** Mechanical hints only. Inputs must come from a host-validated verifier receipt,
 * never an assistant assertion or the optional historical progress journal.
 * Dependency-free for embedding in the managed extension. */
export function createVerificationProgressEvidence(options: { digest: (text: string) => string }) {
	return (input: { subject: string; mode: string; passed: boolean; failures: string[]; sources: { path: string; sha256: string }[] }): VerificationProgressEvidence => {
		if (!input || typeof input.subject !== "string" || typeof input.mode !== "string" || !/^(?:full|scene:[^\x00-\x1f\x7f]{1,256})$/.test(input.mode) || typeof input.passed !== "boolean") throw new TypeError("Invalid verification progress metadata");
		if (!Array.isArray(input.sources) || input.sources.length > 128 || !Array.isArray(input.failures) || input.failures.length > 128) throw new TypeError("Verification progress capacity exceeded");
		// Body bytes and generated reports are outputs, not new contract evidence.
		// Keep actual body SHA in the normal receipt for completion/source gates.
		const sources = input.sources.filter(item => item.path !== input.subject && !item.path.startsWith("planning/verifications/"))
			.map(item => { if (typeof item.path !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new TypeError("Invalid verified source"); return [item.path, item.sha256]; })
			.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
		const diagnostics: Record<string, number> = {};
		for (const raw of input.failures) {
			if (typeof raw !== "string" || raw.length > 8192) throw new TypeError("Invalid verification diagnostic");
			const line = raw.trim().replace(/\s+/g, " ");
			const issue = line.match(/^\[([A-Z0-9_:-]{1,80})\] (.+)$/);
			if (!issue) throw new TypeError("Invalid verification diagnostic syntax");
			const [, code, message] = issue;
			let identity: unknown = [code, message], severity = 1;
			// Recognize only the installed verifier's exact metric grammar. Unknown
			// diagnostics remain opaque identities; no guessed semantic ordering.
			const deficit = code === "MIN_CHARS" ? message.match(/^Chapter has (\d+) characters; required min_chars=(\d+)\.$/) : null;
			const excess = code === "MAX_CHARS" ? message.match(/^Chapter(?: already)? has (\d+) characters; (?:allowed )?max_chars=(\d+)\.$/) : null;
			const scene = code === "SCENE_MIN_CHARS" ? message.match(/^Scene (.+) has (\d+) characters; required min_chars=(\d+)\.$/) : null;
			const budget = code === "SCENE_BUDGET" ? message.match(/^Scene count (\d+) is outside scene_budget (\d+)\.\.(\d+)\.$/) : null;
			const sceneMax = code === "SCENE_BUDGET_MAX" ? message.match(/^Scene count (\d+) exceeds scene_budget.max=(\d+)\.$/) : null;
			const comments = code === "HTML_COMMENT" ? message.match(/^Found (\d+) invalid HTML comment\(s\); only SCENE boundaries are allowed\.$/) : null;
			if (deficit) { identity = [code, Number(deficit[2])]; severity = Number(deficit[2]) - Number(deficit[1]); }
			else if (excess || sceneMax) { const match = (excess ?? sceneMax)!; identity = [code, Number(match[2])]; severity = Number(match[1]) - Number(match[2]); }
			else if (scene) { identity = [code, scene[1], Number(scene[3])]; severity = Number(scene[3]) - Number(scene[2]); }
			else if (budget) { identity = [code, Number(budget[2]), Number(budget[3])]; severity = Math.max(Number(budget[2]) - Number(budget[1]), Number(budget[1]) - Number(budget[3])); }
			else if (comments) { identity = [code]; severity = Number(comments[1]); }
			if (!Number.isSafeInteger(severity) || severity < 1 || severity > 10_000_000) { identity = [code, message]; severity = 1; }
			const key = "diagnostic_" + options.digest(JSON.stringify(identity));
			diagnostics[key] = Math.max(diagnostics[key] ?? 0, severity);
		}
		if (input.passed && Object.keys(diagnostics).length) throw new TypeError("Passing verification cannot contain failures");
		if (!input.passed && !Object.keys(diagnostics).length) diagnostics["diagnostic_" + options.digest("unspecified-failure")] = 1;
		return { mode: input.mode, relatedSourcesDigest: options.digest(JSON.stringify(sources)), diagnostics: Object.fromEntries(Object.entries(diagnostics).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
	};
}
