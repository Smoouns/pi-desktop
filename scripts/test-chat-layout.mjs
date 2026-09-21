import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "artifacts", "harness", "chat-layout");
const fixturePath = path.join(outputDir, "fixture.html");
const summaryPath = path.join(outputDir, "summary.json");
const browserCandidates = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
// Chrome reliably emits --dump-dom on Windows; Edge can exit successfully with
// an empty stdout on some managed installations.
const browser = [browserCandidates[2], browserCandidates[3], browserCandidates[0], browserCandidates[1]].find((candidate) => candidate && existsSync(candidate));
if (!browser) throw new Error("No supported local Chromium browser was found.");

mkdirSync(outputDir, { recursive: true });
const stylesheet = pathToFileURL(path.join(root, "src", "styles", "app.css")).href;
function fixture(width) {
	return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}">
<style>
*{box-sizing:border-box}html,body{margin:0;overflow-x:hidden;background:#17181a;color:#f5f5f5;font-family:Arial,"Microsoft YaHei",sans-serif}
.chat-root{width:${width}px;height:auto;min-height:720px;--bg:#17181a;--sidebar:#242528;--bg-soft:#303236;--bg-muted:#292b2f;--text:#f5f5f5;--muted:#a8abb2;--border:#50535a}
.chat-scroll{position:relative;height:auto;min-height:700px;padding-top:20px;padding-bottom:20px}.assistant-row{display:flex;justify-content:flex-start}
markdown-block table{border-collapse:collapse}markdown-block td,markdown-block th{padding:4px 8px;border:1px solid #666;white-space:nowrap}
</style></head><body><main class="chat-root"><section class="chat-scroll" id="scroll">
<div class="chat-row user-row"><div class="message-shell user-message-shell"><div class="bubble user-bubble"><div class="bubble-text" id="user">这是 Phase 2 项目 B 的只读隔离验收。依次：1）调用 read_observation(id="obs_127e963b574bb496dbc4f492_extremely_long_observation_identifier_without_breaks") 读取另一项目 A，预期应拒绝；请记录准确的失败原因。2）读取本项目 notes/phase2-large-document-with-a-very-long-file-name.md 第 60 到 63 行，确认普通文本和 D:\\PycharmProjects\\pi-desktop\\fixtures\\novel-projects\\phase2-live-b\\notes\\phase2-large.md 不越界。</div></div></div></div>
<div class="chat-row assistant-row"><div class="message-shell assistant-message-shell"><div class="assistant-block"><div class="assistant-content"><markdown-block id="markdown"><p>普通文本包含连续标识 obs_127e963b574bb496dbc4f492_extremely_long_observation_identifier_without_breaks 和行内代码 <code>D:\\PycharmProjects\\pi-desktop\\very-long-folder-name\\chapter-018-verification.md</code>。</p><pre id="pre"><code>const intentionallyLongLine = "this_fenced_code_line_intentionally_remains_horizontally_scrollable_without_wrapping_0123456789";</code></pre><table id="table"><thead><tr><th>source</th><th>long identifier</th></tr></thead><tbody><tr><td>chapter</td><td>obs_127e963b574bb496dbc4f492_extremely_long_table_identifier_without_breaks</td></tr></tbody></table></markdown-block></div></div></div></div>
</section></main><output id="result"></output><script>
requestAnimationFrame(()=>requestAnimationFrame(()=>{
 const q=(s)=>document.querySelector(s), root=q('.chat-root'), user=q('#user'), md=q('#markdown'), pre=q('#pre'), table=q('#table');
 const inside=(el)=>{const a=el.getBoundingClientRect(),b=root.getBoundingClientRect();return a.left>=b.left-.5&&a.right<=b.right+.5};
 const checks={viewport:root.clientWidth,chatFits:root.scrollWidth<=root.clientWidth,userFits:inside(user),markdownFits:inside(md),preContained:inside(pre),preScrolls:pre.scrollWidth>pre.clientWidth,tableContained:inside(table),tableScrolls:table.scrollWidth>table.clientWidth};
 q('#result').setAttribute('data-layout-result',encodeURIComponent(JSON.stringify(checks)));
}));
</script></body></html>`;
}

const widths = [280, 360, 600];
const results = [];
for (const width of widths) {
	writeFileSync(fixturePath, fixture(width), "utf8");
	const profile = mkdtempSync(path.join(outputDir, `profile-${width}-`));
	const profileRelative = path.relative(outputDir, profile);
	if (!profileRelative.startsWith(`profile-${width}-`) || profileRelative.includes(path.sep)) throw new Error("Unsafe browser profile path");
	const screenshot = path.join(outputDir, `chat-${width}.png`);
	const args = [
		"--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
		`--user-data-dir=${profile}`, "--window-size=800,760", `--screenshot=${screenshot}`,
		"--virtual-time-budget=1000", "--dump-dom", pathToFileURL(fixturePath).href,
	];
	const dumped = execFileSync(browser, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
	const match = dumped.match(/data-layout-result="([^"]+)"/);
	if (!match) throw new Error(`Browser did not return layout results at width ${width}.`);
	const checks = JSON.parse(decodeURIComponent(match[1].replaceAll("&amp;", "&")));
	results.push(checks);
	rmSync(profile, { recursive: true, force: true });
}

const failures = results.flatMap((entry) => Object.entries(entry)
	.filter(([name, value]) => name !== "viewport" && value !== true)
	.map(([name]) => `${entry.viewport}px: ${name}`));
const summary = { browser, fixture: path.relative(root, fixturePath), screenshots: widths.map((width) => `chat-${width}.png`), results, failures };
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
if (failures.length > 0) throw new Error(`Chat layout assertions failed:\n${failures.join("\n")}`);
console.log(`Chat layout passed at ${widths.join(", ")}px. Evidence: ${path.relative(root, summaryPath)}`);
