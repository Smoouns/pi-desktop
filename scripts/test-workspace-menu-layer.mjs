import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "artifacts", "harness", "workspace-menu-layer");
const fixturePath = path.join(outputDir, "fixture.html");
const summaryPath = path.join(outputDir, "summary.json");
const cssPath = path.join(root, "src", "styles", "app.css");
const sidebarPath = path.join(root, "src", "components", "sidebar.ts");
const sidebar = readFileSync(sidebarPath, "utf8");

for (const token of [
	'class="sidebar-workspace-menu"',
	'class="sidebar-workspace-row-main"',
	'class="sidebar-panel-body',
	'class="sidebar-project-indicator-btn"',
]) {
	if (!sidebar.includes(token)) throw new Error(`Sidebar template no longer contains ${token}; update this fixture with the production markup.`);
}

const browserCandidates = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browser = browserCandidates.find(existsSync);
if (!browser) throw new Error("No supported local Chromium browser was found.");

mkdirSync(outputDir, { recursive: true });
const stylesheet = pathToFileURL(cssPath).href;

function fixture(theme, legacy) {
	const legacyOverride = legacy ? ".sidebar-topbar{position:static!important;z-index:auto!important}" : "";
	return `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}"><style>
*{box-sizing:border-box}html,body{margin:0;width:340px;height:420px;overflow:hidden;font-family:Arial,"Microsoft YaHei",sans-serif}
:root{--bg:#181b20;--bg-soft:#282d34;--bg-elev:#303640;--sidebar:#20252c;--text:#f2f5f8;--muted:#aab2bd;--muted-2:#77818e;--border:#414955;--accent:#4aa3ff;--top-chrome-height:32px;--desktop-sidebar-opacity:100%;--desktop-sidebar-tint-color:#20252c;--desktop-sidebar-tint-strength:0%;--desktop-sidebar-blur:0px}
:root.light{--bg:#f7f9fc;--bg-soft:#e6ebf1;--bg-elev:#fff;--sidebar:#eef3f8;--text:#17202b;--muted:#627080;--muted-2:#8995a3;--border:#d8dee7}
#sidebar-container{position:relative;width:337px;height:420px}.sidebar-single{position:absolute;inset:0}.sidebar-content-column{width:289px}
${legacyOverride}
</style></head><body><div id="sidebar-container"><div class="sidebar-single"><div class="sidebar-activity-rail"></div><div class="sidebar-content-column">
<div class="sidebar-topbar"><div class="sidebar-workspace-switcher"><div class="sidebar-workspace-switcher-row"><div class="sidebar-workspace-trigger open"><button class="sidebar-workspace-trigger-emoji"><span class="sidebar-workspace-avatar">✨</span></button><button class="sidebar-workspace-trigger-main"><span class="sidebar-workspace-trigger-title">Phase 3 实机验收</span></button><span class="sidebar-workspace-chevron">▴</span></div><button class="sidebar-workspace-create-compact">＋</button></div>
<div class="sidebar-workspace-menu"><div class="sidebar-workspace-list">
<div class="sidebar-workspace-row"><span class="sidebar-workspace-grip">⋮⋮</span><button class="sidebar-workspace-avatar-btn row">🌐</button><button class="sidebar-workspace-row-main" data-workspace="one"><span class="sidebar-workspace-row-title">Workspace 1</span></button></div>
<div class="sidebar-workspace-row"><span class="sidebar-workspace-grip">⋮⋮</span><button class="sidebar-workspace-avatar-btn row">✨</button><button class="sidebar-workspace-row-main" data-workspace="phase1"><span class="sidebar-workspace-row-title">Phase 1 实机验收</span></button></div>
<div class="sidebar-workspace-row"><span class="sidebar-workspace-grip">⋮⋮</span><button class="sidebar-workspace-avatar-btn row">✨</button><button class="sidebar-workspace-row-main" data-workspace="phase2"><span class="sidebar-workspace-row-title">Phase 2 实机验收</span></button></div>
<div class="sidebar-workspace-row active"><span class="sidebar-workspace-grip">⋮⋮</span><button class="sidebar-workspace-avatar-btn row">✨</button><button class="sidebar-workspace-row-main" data-workspace="phase3"><span class="sidebar-workspace-row-title">Phase 3 实机验收</span></button></div>
</div><div class="sidebar-workspace-menu-divider"></div><button class="sidebar-workspace-new">＋ 新建工作区</button></div></div></div>
<div class="sidebar-mode-row"><div class="sidebar-mode-current">资源管理器</div></div>
<div class="sidebar-panel-body"><div class="sidebar-project-list"><div class="sidebar-project-row"><div class="sidebar-project-head"><div class="sidebar-project-main-wrap"><button class="sidebar-project-indicator-btn" id="project"><span class="sidebar-project-leading-emoji">📁</span><span class="sidebar-project-toggle-icon">▾</span></button><button class="sidebar-project-main">project-b</button></div></div></div></div></div>
</div></div></div><output id="result"></output><script>
requestAnimationFrame(()=>requestAnimationFrame(()=>{
 const q=s=>document.querySelector(s), menu=q('.sidebar-workspace-menu'), project=q('#project');
 let selected='', projectClicks=0;
 document.querySelectorAll('.sidebar-workspace-row-main').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.workspace;menu.remove()}));
 project.addEventListener('click',()=>projectClicks++);
 const pr=project.getBoundingClientRect(), menuRect=menu.getBoundingClientRect(), x=pr.left+pr.width/2, y=pr.top+pr.height/2;
 const before=document.elementsFromPoint(x,y), menuAboveProject=before.some(el=>menu.contains(el)||el===menu) && before.indexOf(project)>before.findIndex(el=>menu.contains(el)||el===menu);
 const target=q('[data-workspace="phase2"]'), tr=target.getBoundingClientRect(), targetHit=document.elementFromPoint(tr.left+tr.width/2,tr.top+tr.height/2), hitWorkspaceButton=targetHit?.closest('.sidebar-workspace-row-main')===target;
 targetHit?.closest('.sidebar-workspace-row-main')?.click();
 const after=document.elementsFromPoint(x,y), projectTop=after[0]===project||project.contains(after[0]); after[0]?.click();
 const checks={theme:'${theme}',legacy:${legacy},overlap:x>=menuRect.left&&x<menuRect.right&&y>=menuRect.top&&y<menuRect.bottom,menuAboveProject,topHitBeforeClose:${legacy}?project.contains(before[0]):menu.contains(before[0]),hitWorkspaceButton,workspaceSelectable:selected==='phase2',menuClosed:!document.body.contains(menu),projectTopAfterClose:projectTop,projectClickableAfterClose:projectClicks===1,rects:{menu:{top:menuRect.top,bottom:menuRect.bottom,left:menuRect.left,right:menuRect.right},project:{top:pr.top,bottom:pr.bottom,left:pr.left,right:pr.right}}};
 q('#result').setAttribute('data-layer-result',encodeURIComponent(JSON.stringify(checks)));
}));
</script></body></html>`;
}

const results = [];
for (const theme of ["light", "dark"]) {
	for (const legacy of [true, false]) {
		writeFileSync(fixturePath, fixture(theme, legacy), "utf8");
		const profile = mkdtempSync(path.join(outputDir, `profile-${theme}-${legacy ? "old" : "new"}-`));
		const profileRelative = path.relative(outputDir, profile);
		if (profileRelative.startsWith("..") || path.isAbsolute(profileRelative) || !profileRelative.startsWith(`profile-${theme}-${legacy ? "old" : "new"}-`)) throw new Error("Unsafe browser profile path.");
		try {
			const dumped = execFileSync(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${profile}`, "--window-size=340,420", "--virtual-time-budget=1000", "--dump-dom", pathToFileURL(fixturePath).href], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
			const match = dumped.match(/data-layer-result="([^"]+)"/);
			if (!match) throw new Error(`Browser returned no layer result for ${theme}/${legacy ? "old" : "new"}.`);
			results.push(JSON.parse(decodeURIComponent(match[1].replaceAll("&amp;", "&"))));
		} finally {
			rmSync(profile, { recursive: true, force: true });
		}
	}
}

const common = ["overlap", "topHitBeforeClose", "hitWorkspaceButton", "workspaceSelectable", "menuClosed", "projectTopAfterClose", "projectClickableAfterClose"];
const failures = results.flatMap((result) => [
	...common.filter((key) => !result[key]).map((key) => `${result.theme}/${result.legacy ? "old" : "new"}: ${key}`),
	...(result.legacy && result.menuAboveProject ? [`${result.theme}/old: expected the historical layering bug`] : []),
	...(!result.legacy && !result.menuAboveProject ? [`${result.theme}/new: menu is not above the project icon`] : []),
]);
const summary = { browser, sourceTemplate: path.relative(root, sidebarPath), stylesheet: path.relative(root, cssPath), results, failures };
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
if (failures.length) throw new Error(`Workspace menu layer assertions failed:\n${failures.join("\n")}`);
console.log(`Workspace menu layer regression passed in light and dark themes. Evidence: ${path.relative(root, summaryPath)}`);
