/** Real Chromium layout/actions check for the context-usage dialog; no Pi/model requests. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts/harness/context-usage-ui");
const browser = [
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);
assert.ok(browser, "No local Chromium browser available");
const assets = path.join(root, "dist/assets");
const css = readdirSync(assets).find((name) => /^index-.*\.css$/.test(name));
assert.ok(css, "Run npm run build:frontend before this browser check");
mkdirSync(output, { recursive: true });

const bundled = await build({
	stdin: { contents: `
import { html, render } from 'lit';
import { renderContextUsageView, sanitizeContextBudgetSnapshot } from './src/components/chat-view/context-usage-view.ts';
const check=(value,label)=>{if(!value)throw new Error(label)};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const budget=sanitizeContextBudgetSnapshot({version:1,sessionId:'session-a',provider:'google',modelId:'gemini-3.8-flash-high',capacity:{contextWindow:262144,maxOutputTokens:16384,source:'model-config',verified:false,declaredContextWindow:1048576,declaredMaxOutputTokens:65536,declaredSource:'user-confirmed'},ledger:{system:3000,tools:9000,history:77000,checkpoint:5000,observationPreview:1600,newEvidence:900,serializationOverhead:1200,outputReserve:16384,safetyMargin:4096,total:118180,limit:262144,available:143964,inputEstimate:97700,rawInputBytes:345071},estimator:'estimated_tokens',phase:'after-tool-trim',trimmedToolResults:12,autoCompaction:'idle',measuredAt:1});
let closes=0,refreshes=0,compacts=0,toggles=0,modelRequests=0;
const host=document.querySelector('#host');
function show(currentTokens=null,usageRatio=null){render(renderContextUsageView({open:true,refreshing:false,compacting:false,connected:true,streaming:false,currentTokens,contextWindow:262144,usageRatio,autoCompactionEnabled:true,budget,onClose:()=>{closes++},onRefresh:()=>{refreshes++},onCompact:()=>{compacts++},onToggleAutoCompaction:()=>{toggles++}}),host)}
async function run(){
 show(); await pause();
 const dialog=document.querySelector('[role=dialog]');
 check(dialog,'dialog visible');
 check(dialog.textContent.includes('Pi 当前上下文估算')&&dialog.textContent.includes('未知'),'unknown current usage visible');
 check(dialog.textContent.includes('118,180 / 262,144'),'request budget visible');
	check(dialog.textContent.includes('当前工作窗口')&&dialog.textContent.includes('262,144'),'effective working window visible');
	check(dialog.textContent.includes('当前最大输出 16,384'),'effective output allowance visible');
	check(dialog.textContent.includes('服务商容量（用户确认）')&&dialog.textContent.includes('1,048,576')&&dialog.textContent.includes('最大输出 65,536'),'declared provider capacity visible');
 check(dialog.textContent.includes('token 估算'),'estimator is explicit');
 check(dialog.textContent.includes('未由服务商实时验证'),'capacity provenance visible');
 check(dialog.textContent.includes('查看和刷新不会调用模型'),'no-model-query boundary visible');
 const rect=dialog.getBoundingClientRect();
 check(rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,'dialog fits viewport');
 check(dialog.scrollWidth<=dialog.clientWidth,'dialog has no horizontal overflow');
 const buttons=[...dialog.querySelectorAll('button')];
 buttons.find(button=>button.textContent.includes('刷新')).click();
 buttons.find(button=>button.textContent.includes('立即压缩')).click();
 dialog.querySelector('input[type=checkbox]').click();
 check(refreshes===1&&compacts===1&&toggles===1,'actions dispatched once');
 check(modelRequests===0,'render and refresh controls do not create hidden model request');
 show(64000,64000/262144); await pause();
 check(document.querySelector('[role=dialog]').textContent.includes('64,000'),'current Pi estimate updates');
 document.documentElement.setAttribute('data-result',JSON.stringify({pass:true,width:innerWidth,refreshes,compacts,toggles,closes,modelRequests}));
}
run().catch(error=>document.documentElement.setAttribute('data-result',JSON.stringify({pass:false,error:String(error)})));
`, resolveDir: root, loader: "ts" },
	bundle: true, platform: "browser", format: "iife", write: false, logLevel: "warning",
});

const results = [];
for (const width of [500, 900]) {
	const fixture = path.join(output, `context-${width}.html`);
	writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"><style>html,body{margin:0;height:100%;background:#090b10}#host{height:100%}</style></head><body><main id="host"></main><script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`);
	const profile = mkdtempSync(path.join(output, `profile-${width}-`));
	try {
		const dom = execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${profile}`, `--window-size=${width},760`, "--virtual-time-budget=3000", `--screenshot=${path.join(output, `context-${width}.png`)}`, "--dump-dom", pathToFileURL(fixture).href], { encoding: "utf8", maxBuffer: 8_000_000, timeout: 30_000 });
		const match = dom.match(/data-result="([^"]*)"/);
		assert.ok(match, "Browser did not report UI results");
		const result = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
		assert.equal(result.pass, true, JSON.stringify(result));
		results.push(result);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
}
writeFileSync(path.join(output, "summary.json"), JSON.stringify({ browser, results }, null, 2));
console.log("Context usage UI browser checks passed", results);
