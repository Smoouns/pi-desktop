import assert from "node:assert/strict";
import { createStoryRangeReader } from "../../src/novel/read-range.js";
import type { RunCase } from "./testkit.js";

const expectInvalid = (body: () => unknown): void => assert.throws(body, (error: unknown) => typeof error === "object" && error !== null && "kind" in error && (error as { kind: string }).kind === "invalid_input");

export async function runStoryRangeCases(runCase: RunCase): Promise<void> {
	await runCase("RANGE-01 whole text and original newlines remain exact", (record) => {
		const reader = createStoryRangeReader();
		const source = "# 第一章\r\n正文 A\r\n正文 B\r\n";
		assert.deepEqual(reader.select(source), { text: source, startLine: 1, endLine: 4, totalLines: 4, complete: true });
		assert.deepEqual(reader.select(source, { startLine: 2, endLine: 3 }), { text: "正文 A\r\n正文 B\r\n", startLine: 2, endLine: 3, totalLines: 4, complete: false });
		record("range_newline_preserved", { totalLines: 4 });
	});

	await runCase("RANGE-02 section respects heading hierarchy and fenced code", (record) => {
		const reader = createStoryRangeReader();
		const source = ["# 卷一", "引子", "## 场景甲", "正文", "```md", "## 伪标题", "```", "### 子场景", "细节", "## 场景乙", "结束"].join("\n");
		assert.deepEqual(reader.select(source, { section: "场景甲" }), { text: ["## 场景甲", "正文", "```md", "## 伪标题", "```", "### 子场景", "细节", ""].join("\n"), startLine: 3, endLine: 9, totalLines: 11, complete: false });
		assert.equal(reader.select(source, { section: "卷一" }).endLine, 11);
		record("section_selected", { fencedHeadingIgnored: true });
	});

	await runCase("RANGE-03 tilde fences and trailing newline are deterministic", (record) => {
		const reader = createStoryRangeReader();
		const source = "# 根\n~~~\n# 假\n~~~\n## 真\n内容\n";
		const selected = reader.select(source, { section: "真" });
		assert.deepEqual(selected, { text: "## 真\n内容\n", startLine: 5, endLine: 7, totalLines: 7, complete: false });
		record("trailing_newline_creates_empty_final_line", { totalLines: selected.totalLines });
	});

	await runCase("RANGE-04 ambiguous missing and invalid selectors fail closed", (record) => {
		const reader = createStoryRangeReader();
		const duplicate = "# 重名\nA\n# 重名\nB";
		expectInvalid(() => reader.select(duplicate, { section: "重名" }));
		expectInvalid(() => reader.select(duplicate, { section: "缺失" }));
		expectInvalid(() => reader.select(duplicate, { section: "重名", startLine: 1 }));
		for (const range of [{ startLine: 0 }, { startLine: 5 }, { endLine: 5 }, { startLine: 3, endLine: 2 }, { startLine: 1.5 }]) expectInvalid(() => reader.select("a\nb", range));
		expectInvalid(() => reader.select("a", { section: " " }));
		record("invalid_selectors_rejected", { rejected: 9 });
	});

	await runCase("RANGE-05 factory is standalone when embedded", (record) => {
		const factoryText = createStoryRangeReader.toString();
		const standalone = Function(`"use strict"; return (${factoryText});`)() as typeof createStoryRangeReader;
		const compact = Function(`"use strict";return(${factoryText.replace(/\n\s*/g, "")})`)() as typeof createStoryRangeReader;
		for (const factory of [standalone, compact]) assert.equal(factory().select("# A\nbody", { section: "A" }).text, "# A\nbody");
		record("standalone_factory", { variants: 2 });
	});

	await runCase("RANGE-06 literal trailing hash is part of the heading", (record) => {
		const reader = createStoryRangeReader();
		const source = "# C#\n语言\n# D ##\n结尾";
		assert.equal(reader.select(source, { section: "C#" }).text, "# C#\n语言\n");
		assert.equal(reader.select(source, { section: "D" }).text, "# D ##\n结尾");
		expectInvalid(() => reader.select(source, { section: "C" }));
		record("commonmark_closing_hash", { literalPreserved: true });
	});
}
