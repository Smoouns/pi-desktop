/**
 * Real ChatView context-entry layout check. This deliberately uses the complete
 * renderApp workbench hierarchy and the production stylesheet without adding
 * height or overflow repairs. It performs no RPC/model requests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "artifacts/harness/context-entry-ui");
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
	stdin: {
		contents: `
import { ChatView } from './src/components/chat-view.ts';
import { ContextInspector } from './src/components/context-inspector.ts';
const check=(value,label,detail={})=>{if(!value)throw new Error(label+' '+JSON.stringify(detail))};
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
const pane=document.querySelector('#session-pane');
const layout=document.querySelector('#chat-file-layout');
const terminal=document.querySelector('#terminal-pane');
const chat=new ChatView(document.querySelector('#chat-container'));
const inspector=new ContextInspector(document.querySelector('#context-inspector-pane'));
inspector.setProjectPath('C:/synthetic/context-entry');
chat.projectPath='C:/synthetic/context-entry';
chat.isConnected=true;
chat.state={
 sessionId:'synthetic-context-entry',isStreaming:false,isCompacting:false,autoCompactionEnabled:true,
 model:{provider:'google',id:'gemini-3.8-flash-high-with-an-intentionally-long-visible-model-name',name:'Gemini 3.8 Flash High with an intentionally long visible model name',contextWindow:262144,maxTokens:65536},
 thinkingLevel:'high'
};
chat.sessionStats={...chat.sessionStats,tokens:65536,contextWindow:262144,usageRatio:.25};
chat.setExtensionStatus({key:'novel-supervisor',text:'候选任务已完成：planning/verifications/019-verification.md',onOpen:()=>{}});
let refreshes=0;
// Suppress only transport. Rendering, entry events and dialog state remain real.
chat.refreshContextUsage=async()=>{refreshes++};

function clippingEvidence(entry){
 const er=entry.getBoundingClientRect();
 const ancestors=[];
 for(let node=entry.parentElement;node;node=node.parentElement){
  const style=getComputedStyle(node);
  const overflow=[style.overflow,style.overflowX,style.overflowY];
  if(overflow.some(value=>value!=='visible')){
   const rect=node.getBoundingClientRect();
   const contains=er.left>=rect.left-.5&&er.right<=rect.right+.5&&er.top>=rect.top-.5&&er.bottom<=rect.bottom+.5;
   ancestors.push({id:node.id,className:node.className,overflow,contains,rect:{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom}});
  }
 }
 return {entry:{left:er.left,top:er.top,right:er.right,bottom:er.bottom,width:er.width,height:er.height},ancestors};
}

async function exercise(width,terminalOpen,light){
 document.documentElement.classList.toggle('light',light);
 document.documentElement.classList.toggle('dark',!light);
 layout.style.setProperty('--chat-panel-width',width+'px');
 terminal.classList.toggle('hidden-pane',!terminalOpen);
 terminal.classList.toggle('terminal-dock-visible',terminalOpen);
 if(terminalOpen) terminal.style.setProperty('--terminal-dock-height','180px');
 chat.render();await pause();
 const entry=document.querySelector('.session-stats-ring');check(entry,'entry exists',{width,terminalOpen,light});
 check(entry.textContent.includes('上下文用量')&&entry.textContent.includes('25%'),'entry has visible label and percentage',{width,terminalOpen,light,text:entry.textContent});
 check(entry.getAttribute('aria-haspopup')==='dialog','entry advertises dialog',{width,terminalOpen,light});
 check(!entry.hasAttribute('title'),'entry avoids native duplicate tooltip',{width,terminalOpen,light,title:entry.getAttribute('title')});
 const statsWrap=entry.closest('.session-stats-wrap');check(statsWrap,'entry stats wrapper exists',{width,terminalOpen,light});
 statsWrap.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));await pause();
 const tooltip=document.querySelector('.session-stats-popover');check(tooltip,'hover shows usage tooltip',{width,terminalOpen,light});
 check(tooltip.getAttribute('role')==='tooltip','hover content has tooltip role',{width,terminalOpen,light,role:tooltip.getAttribute('role')});
 check(Boolean(tooltip.id)&&entry.getAttribute('aria-describedby')===tooltip.id,'entry references tooltip accessibly',{width,terminalOpen,light,id:tooltip.id,describedBy:entry.getAttribute('aria-describedby')});
 const tooltipText=tooltip.textContent.replace(/\\s+/g,' ').trim();
 check(tooltipText==='已用 65,536 / 共计 262,144 tokens','tooltip contains only concise token usage',{width,terminalOpen,light,tooltipText});
 const hoverRect=entry.getBoundingClientRect(),tooltipRect=tooltip.getBoundingClientRect();
 check(tooltipRect.bottom<=hoverRect.top-6,'tooltip stays above and clear of entry',{width,terminalOpen,light,entryTop:hoverRect.top,tooltipBottom:tooltipRect.bottom});
 const hoverHit=document.elementFromPoint(hoverRect.left+hoverRect.width/2,hoverRect.top+hoverRect.height/2);
 check(entry.contains(hoverHit),'tooltip does not cover entry hit target',{width,terminalOpen,light,hit:hoverHit?.className});
 statsWrap.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));await pause();
 check(!document.querySelector('.session-stats-popover'),'tooltip disappears on mouseleave',{width,terminalOpen,light});
 check(getComputedStyle(entry).cursor==='pointer','entry has clickable affordance',{width,terminalOpen,light,cursor:getComputedStyle(entry).cursor});
 const evidence=clippingEvidence(entry),rect=entry.getBoundingClientRect(),panel=pane.getBoundingClientRect();
 check(Math.abs(panel.width-width)<1,'session pane follows product width variable',{width,terminalOpen,light,actualWidth:panel.width});
 check(rect.width>=24&&rect.height>=24,'entry has visible hit target',{width,terminalOpen,light,evidence});
 check(rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,'entry fits viewport',{width,terminalOpen,light,viewport:{width:innerWidth,height:innerHeight},evidence});
 check(rect.left>=panel.left&&rect.right<=panel.right&&rect.top>=panel.top&&rect.bottom<=panel.bottom,'entry fits session pane',{width,terminalOpen,light,panel:{left:panel.left,top:panel.top,right:panel.right,bottom:panel.bottom},evidence});
 check(evidence.ancestors.every(item=>item.contains),'no overflow ancestor clips entry',{width,terminalOpen,light,evidence});
 const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
 check(entry.contains(hit),'entry is not covered',{width,terminalOpen,light,hit:hit?.className,evidence});
 const before=refreshes;entry.click();await pause();
 const dialog=document.querySelector('[aria-label="上下文使用情况"]');check(dialog,'entry opens dialog',{width,terminalOpen,light});
 check(refreshes===before+1,'opening refreshes once',{width,terminalOpen,light,before,refreshes});
 const dr=dialog.getBoundingClientRect();
 check(dr.left>=0&&dr.right<=innerWidth&&dr.top>=0&&dr.bottom<=innerHeight,'dialog fits viewport',{width,terminalOpen,light,dialog:{left:dr.left,top:dr.top,right:dr.right,bottom:dr.bottom}});
 check(dialog.contains(document.elementFromPoint(dr.left+dr.width/2,dr.top+20)),'dialog is not covered',{width,terminalOpen,light});
 dialog.querySelector('.context-usage-close').click();await pause();
 check(!document.querySelector('[aria-label="上下文使用情况"]'),'dialog closes',{width,terminalOpen,light});
 return {width,terminalOpen,theme:light?'light':'dark',evidence};
}

async function run(){
 const checks=[];
 for(const light of [false,true]) for(const width of [300,360,520]) for(const terminalOpen of [false,true]) checks.push(await exercise(width,terminalOpen,light));
 chat.sessionStats={...chat.sessionStats,tokens:null,usageRatio:null};chat.render();await pause();
 const unknownEntry=document.querySelector('.session-stats-ring');
 check(unknownEntry.textContent.includes('—')&&!unknownEntry.textContent.includes('0%'),'unknown usage is not shown as zero',{text:unknownEntry.textContent});
 const unknownWrap=unknownEntry.closest('.session-stats-wrap');
 unknownWrap.dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));await pause();
 const unknownTooltip=document.querySelector('.session-stats-popover');check(unknownTooltip,'unknown usage hover tooltip appears');
 const unknownTooltipText=unknownTooltip.textContent.replace(/\\s+/g,' ').trim();
 check(unknownTooltipText==='已用 — / 共计 262,144 tokens','unknown tooltip does not pretend zero',{unknownTooltipText});
 unknownWrap.dispatchEvent(new MouseEvent('mouseleave',{bubbles:false}));await pause();
 check(!document.querySelector('.session-stats-popover'),'unknown tooltip disappears on mouseleave');
 unknownEntry.click();await pause();
 check(document.querySelector('[aria-label="上下文使用情况"]'),'unknown usage still opens dialog');
 document.querySelector('.context-usage-close').click();await pause();
 const contextTrigger=document.querySelector('.context-summary-trigger');check(contextTrigger,'context inspector trigger exists');
 contextTrigger.click();await pause();
 const workbench=document.querySelector('[aria-label="上下文工作台"]');check(workbench,'context workbench opens');
 const wr=workbench.getBoundingClientRect();
 check(wr.left>=0&&wr.right<=innerWidth&&wr.top>=0&&wr.bottom<=innerHeight,'context workbench fits full viewport',{rect:{left:wr.left,top:wr.top,right:wr.right,bottom:wr.bottom},viewport:{width:innerWidth,height:innerHeight}});
 check(workbench.contains(document.elementFromPoint(wr.left+wr.width/2,wr.top+20)),'context workbench is not covered');
 workbench.querySelector('[title="关闭上下文工作台"]').click();await pause();
 check(!document.querySelector('[aria-label="上下文工作台"]'),'context workbench closes');
 // Stable final visual state for the generated screenshots.
 document.documentElement.classList.remove('light');document.documentElement.classList.add('dark');
 layout.style.setProperty('--chat-panel-width','360px');
 terminal.classList.add('hidden-pane');terminal.classList.remove('terminal-dock-visible');
 chat.sessionStats={...chat.sessionStats,tokens:29698,contextWindow:262144,usageRatio:29698/262144};chat.render();await pause();
 document.querySelector('.session-stats-wrap').dispatchEvent(new MouseEvent('mouseenter',{bubbles:false}));await pause();
 const screenshotTooltip=document.querySelector('.session-stats-popover');check(screenshotTooltip,'screenshot tooltip appears');
 check(screenshotTooltip.textContent.replace(/\\s+/g,' ').trim()==='已用 29,698 / 共计 262,144 tokens','screenshot shows representative compact usage',{text:screenshotTooltip.textContent});
 document.documentElement.setAttribute('data-result',JSON.stringify({pass:true,checks,refreshes,modelRequests:0}));
}
run().catch(error=>document.documentElement.setAttribute('data-result',JSON.stringify({pass:false,error:String(error),modelRequests:0})));
`,
		resolveDir: root,
		loader: "ts",
	},
	bundle: true,
	platform: "browser",
	format: "iife",
	define: { "import.meta.url": JSON.stringify(pathToFileURL(path.join(root, "src/components/chat-view.ts")).href) },
	write: false,
	logLevel: "warning",
});

const results = [];
for (const height of [520, 760, 920]) {
	const fixture = path.join(output, `entry-${height}.html`);
	// Complete structural hierarchy emitted by src/main.ts renderApp. Inert
	// placeholders replace instantiated sidebar/tab/file/terminal components.
	writeFileSync(fixture, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"></head><body><div id="app"><div class="app-shell"><pre id="runtime-debug-overlay" class="runtime-debug-overlay hidden"></pre><div class="content-shell"><div id="sidebar-container"><div class="sidebar-single">资源管理器</div></div><div id="sidebar-resize-handle"></div><div id="main-pane"><div id="content-tabs-container" data-tauri-drag-region><div class="content-tabs-root"><div class="content-tabs-scroll">019-verification.md</div></div></div><div id="chat-file-layout"><div id="session-pane"><div id="chat-container"></div><div id="context-inspector-pane"></div><div id="terminal-pane" class="hidden-pane"><div class="terminal-panel-root"><div class="terminal-resize-handle"></div><div class="terminal-panel-header">终端</div><div class="terminal-panel-viewport"></div></div></div></div><div id="file-split-resize-handle" class="hidden-pane"></div><div id="file-pane" class="hidden-pane"></div><div id="editor-empty-state" class="editor-empty-state"><div class="editor-empty-icon">P</div><strong>Select a file to start editing</strong><span>Choose a document from the Explorer or create a new tab.</span></div></div><div id="packages-pane" class="hidden-pane"></div><div id="settings-pane" class="hidden-pane"></div><div id="novel-workflow-dialog-pane"></div><div id="world-change-dialog-pane"></div></div></div></div></div></div><script>const report=e=>document.documentElement.setAttribute('data-result',JSON.stringify({pass:false,error:String(e.reason??e.error??e.message??e),modelRequests:0}));window.addEventListener('error',report);window.addEventListener('unhandledrejection',report);</script><script>${bundled.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`);
	const profile = mkdtempSync(path.join(output, `profile-${height}-`));
	try {
		const dom = execFileSync(browser, [
			"--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
			`--user-data-dir=${profile}`, `--window-size=1200,${height}`, "--virtual-time-budget=6000",
			`--screenshot=${path.join(output, `entry-${height}.png`)}`, "--dump-dom", pathToFileURL(fixture).href,
		], { encoding: "utf8", maxBuffer: 12_000_000, timeout: 30_000 });
		const match = dom.match(/data-result="([^"]*)"/);
		assert.ok(match, `Browser did not report entry results at height ${height}`);
		const result = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
		writeFileSync(path.join(output, `summary-${height}.json`), JSON.stringify(result, null, 2));
		console.log(JSON.stringify({ height, ...result }));
		assert.equal(result.pass, true, JSON.stringify({ height, ...result }));
		results.push({ height, ...result });
	} finally {
		const relative = path.relative(output, profile);
		assert.ok(relative.startsWith(`profile-${height}-`) && !relative.includes(path.sep), "Unsafe cleanup target");
		rmSync(profile, { recursive: true, force: true });
	}
}
writeFileSync(path.join(output, "summary.json"), JSON.stringify({ browser, results }, null, 2));
