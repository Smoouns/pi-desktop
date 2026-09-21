/** Headless Chromium check of the real Lit/RPC UI handler; no Pi/model requests. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts/harness/extension-status-ui");
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
const script = await build({
	stdin: { contents: `
import { ExtensionUiHandler, normalizeExtensionUiRequest } from './src/components/extension-ui-handler.ts';
import { renderExtensionStatusView } from './src/components/chat-view/extension-status-view.ts';
import { html, render } from 'lit';
const check=(value,label)=>{if(!value)throw new Error(label)};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
async function run(){
 const ui=Object.create(ExtensionUiHandler.prototype);
 ui.statusTexts=new Map(); ui.activeReadonlyDialogClose=null;
 ui.createContainers();
 const responses=[]; ui.sendResponse=async(id,data)=>{responses.push({id,...data})};
 const pane=document.querySelector('#session-pane');
 const editor=document.querySelector('#editor-pane');
 const composer=document.querySelector('#test-composer-inner');
 let displayedStatus=null;
 ui.setStatusDisplayHandler(status=>{
  displayedStatus=status;
  render(html\`\${renderExtensionStatusView(status)}<div class="composer-panel"><div class="composer-row"><textarea id="chat-input" class="chat-input" rows="1">测试输入框</textarea></div></div>\`,composer);
 });
 const detail='前置条件不足（MODEL_INPUT_BUDGET_EXCEEDED）。当前保守估算 345071 / 预算上限 128000。输入按 UTF-8 字节估算，并含输出预留与安全余量；不是模型实际 token 数。'+ '\\n只读查询，不启动模型，不修改验收记录。'.repeat(20);
 const request=id=>normalizeExtensionUiRequest({type:'extension_ui_request',id,method:'confirm',title:'小说运行状态',message:detail});
 let visible=ui.handleRequest(request('button')); await pause();
 const overlay=document.querySelector('#extension-ui-overlay');
 let dialog=overlay.querySelector('[role=dialog]');
 check(dialog&&getComputedStyle(overlay).display!=='none','RPC dialog must be visible');
 check(dialog.textContent.includes('345071')&&dialog.textContent.includes('128000'),'budget figures visible');
 check(dialog.querySelectorAll('button').length===1,'only one read-only close action');
 const rect=dialog.getBoundingClientRect();
 check(rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,'dialog fits viewport');
 check(dialog.contains(document.elementFromPoint(rect.left+rect.width/2,rect.top+10)),'dialog is not covered');
 check(dialog.scrollWidth<=dialog.clientWidth,'no horizontal text overflow');
 const close=dialog.querySelector('button'); close.click(); close.click(); await visible;
 check(responses.length===1&&responses[0].confirmed===false,'one non-mutating close response');
 visible=ui.handleRequest(request('escape')); await pause();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await visible;
 check(responses.length===2,'Escape closes once');
 visible=ui.handleRequest(request('backdrop')); await pause();
 overlay.querySelector('[role=dialog]').parentElement.click(); await visible;
 check(responses.length===3,'backdrop closes once');
 for(const r of [
  {id:'s1',method:'setStatus',statusKey:'novel-supervisor',statusText:detail},
  {id:'s2',method:'setStatus',statusKey:'unrelated',statusText:'其他状态'},
  {id:'s3',method:'setStatus',statusKey:'unrelated'},
  {id:'s4',method:'setStatus',statusKey:'smart-voice-notify',statusText:'ignored'},
 ]) await ui.handleRequest(r);
 check(displayedStatus?.key==='novel-supervisor','other status cannot erase supervisor');
 check(!document.querySelector('#extension-status-container'),'status must not mount on document.body');
 const paneWidths=[];
 for(const width of [280,360,430]){
  pane.style.flex='0 0 '+width+'px'; pane.style.width=width+'px'; await pause();
  const status=document.querySelector('.chat-extension-status');
  const textarea=document.querySelector('#chat-input');
  const paneRect=pane.getBoundingClientRect(), statusRect=status.getBoundingClientRect(), inputRect=textarea.getBoundingClientRect(), editorRect=editor.getBoundingClientRect();
  check(Math.abs(paneRect.width-width)<1,'chat pane width must be '+width);
  check(statusRect.left>=paneRect.left&&statusRect.right<=paneRect.right,'status must fit chat pane at '+width);
  check(statusRect.left>=editorRect.right,'status must not cover editor at '+width);
  check(statusRect.bottom<=inputRect.top,'status must stay above textarea at '+width);
  check(status.scrollWidth<=status.clientWidth,'compact status must not overflow at '+width);
  paneWidths.push({requested:width,actual:Math.round(paneRect.width)});
 }
 const beforeDetailsResponses=responses.length;
 document.querySelector('.chat-extension-status-details').click(); await pause();
 dialog=overlay.querySelector('[role=dialog]');
 check(dialog&&dialog.textContent.includes('345071')&&dialog.textContent.includes('128000'),'local details show full status');
 check(responses.length===beforeDetailsResponses,'local details must not emit RPC response');
 dialog.querySelector('button').click(); await pause();
 check(responses.length===beforeDetailsResponses,'closing local details must not emit RPC response');
 ui.clearSessionStatus(); await pause();
 check(!document.querySelector('.chat-extension-status'),'runtime clear removes compact status');
 await ui.handleRequest({id:'s5',method:'setStatus',statusKey:'novel-supervisor',statusText:detail}); await pause();
 check(document.querySelector('.chat-extension-status'),'status can reopen after runtime clear');
 pane.style.flex='0 0 360px'; pane.style.width='360px'; await pause();
 document.documentElement.setAttribute('data-result',JSON.stringify({pass:true,width:innerWidth,paneWidths,closes:responses.length,modelRequests:0}));
}
run().catch(error=>{document.documentElement.setAttribute('data-result',JSON.stringify({pass:false,error:String(error)}))});
`, resolveDir: root, loader: "ts" },
	bundle: true, platform: "browser", format: "iife", write: false, logLevel: "warning",
});
const results = [];
for (const width of [700, 1000]) {
	const fixture = path.join(output, `status-${width}.html`);
	writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"><style>html,body{margin:0;height:100%;overflow:hidden}#test-layout{display:flex;width:100%;height:100%}#editor-pane{flex:1 1 auto;min-width:0;background:#111827;color:#94a3b8;padding:20px}#session-pane{position:relative;height:100%;min-width:0}#chat-container,.chat-root{width:100%;height:100%}.composer-shell{pointer-events:auto}</style></head><body><main id="test-layout"><section id="editor-pane">正文编辑区</section><aside id="session-pane"><div id="chat-container"><div class="chat-root"><div class="chat-scroll"></div><div class="composer-shell"><div class="composer-inner" id="test-composer-inner"></div></div></div></div></aside></main><script>const reportBootstrapError=event=>{const error=event?.reason??event?.error??event?.message??event;document.documentElement.setAttribute('data-result',JSON.stringify({pass:false,error:String(error)}));};window.addEventListener('error',reportBootstrapError);window.addEventListener('unhandledrejection',reportBootstrapError);</script><script>${script.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`);
	const profile = mkdtempSync(path.join(output, `profile-${width}-`));
	try {
		const dom = execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${profile}`, `--window-size=${width},720`, "--virtual-time-budget=4000", `--screenshot=${path.join(output, `status-${width}.png`)}`, "--dump-dom", pathToFileURL(fixture).href], { encoding: "utf8", maxBuffer: 8_000_000, timeout: 30_000 });
		const match = dom.match(/data-result="([^"]*)"/);
		assert.ok(match, "Browser did not report UI results");
		const result = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
		assert.equal(result.pass, true, JSON.stringify(result));
		results.push(result);
	} finally {
		const relative = path.relative(output, profile);
		assert.ok(relative.startsWith(`profile-${width}-`) && !relative.includes(path.sep));
		rmSync(profile, { recursive: true, force: true });
	}
}
writeFileSync(path.join(output, "summary.json"), JSON.stringify({ browser, results }, null, 2));
console.log("Extension status UI browser checks passed", results);
