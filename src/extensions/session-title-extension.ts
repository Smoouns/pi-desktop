const SESSION_TITLE_EXTENSION_FILE = "pi-desktop-session-title.ts";
const SESSION_TITLE_EXTENSION_MARKER = "pi-desktop-session-title-extension/v1";
const SESSION_TITLE_EXTENSION_MARKER_PREFIX = "pi-desktop-session-title-extension/";

export const SESSION_TITLE_EXTENSION_CONTENT = `/**
 * ${SESSION_TITLE_EXTENSION_MARKER}
 * Background, one-shot session naming for Pi Desktop.
 */
const ATTEMPT = "pi-desktop-session-title-attempt/v1";
const STATUS_KEY = "pi-desktop-session-title";
const TIMEOUT_MS = 15000;
const MAX_OUTPUT_TOKENS = 384;
const secretPatterns = [
  /\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi,
  /\\b(?:api[_-]?key|token|secret|password|authorization)\\s*[:=]\\s*[^\\s,;]+/gi,
  /\\b(?:sk|AIza|ghp|github_pat|xox[baprs])-?[A-Za-z0-9_-]{12,}\\b/g,
];
const visibleText = (value, limit) => {
  let text = typeof value === "string" ? value : Array.isArray(value)
    ? value.flatMap(part => part && typeof part === "object" && part.type === "text" ? [String(part.text || "")] : []).join("\\n") : "";
  text = text
    .replace(/<novel-(?:context|role|project|task|checkpoint)\\b[^>]*>[\\s\\S]*?<\\/novel-(?:context|role|project|task|checkpoint)>/gi, " ")
    .replace(/<novel-(?:context|role|project|task|checkpoint)\\b[^>]*\\/>/gi, " ");
  for (const pattern of secretPatterns) text = text.replace(pattern, "[已隐藏]");
  return text.replace(/\\s+/g, " ").trim().slice(0, limit);
};
const seedFrom = messages => {
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === "assistant") { assistantIndex = i; break; }
  }
  if (assistantIndex < 0) return null;
  const latestAssistant = messages[assistantIndex];
  if (!["stop", "length"].includes(latestAssistant.stopReason)) return null;
  const assistant = visibleText(latestAssistant.content, 700);
  if (!assistant) return null;
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    const user = visibleText(message.content, 1200);
    if (user) return { user, assistant };
  }
  return null;
};
const normalizeTitle = value => {
  if (typeof value !== "string") return null;
  const first = value.split(/\\r?\\n/).find(line => line.trim()) || "";
  const title = first.replace(/^\\s*(?:标题|title)\\s*[:：]\\s*/i, "")
    .replace(/^[\\x60'"“”‘’#*\\s]+|[\\x60'"“”‘’#*\\s]+$/g, "")
    .replace(/[\\u0000-\\u001f\\u007f]/g, "").replace(/\\s+/g, " ").trim().slice(0, 60);
  return title.length >= 2 ? title : null;
};
const responseText = response => Array.isArray(response && response.content)
  ? response.content.filter(part => part && part.type === "text").map(part => part.text || "").join("\\n") : "";
const loadComplete = async () => {
  try { return (await import("@earendil-works/pi-ai/compat")).complete; }
  catch { return (await import("@mariozechner/pi-ai")).complete; }
};

export default function (pi) {
  // Installed globally, but automatic naming belongs only to the Desktop chat
  // runtime. Standalone CLI and maintenance bridges must opt in explicitly.
  if (process.env.PI_DESKTOP_SESSION_TITLE !== "1") return;
  let generation = 0;
  let controller = null;
  const invalidate = () => { generation += 1; if (controller) controller.abort(); controller = null; };
  for (const event of ["session_start", "session_switch", "session_shutdown", "model_select"])
    pi.on(event, invalidate);

  pi.on("agent_end", (event, ctx) => {
    if ((pi.getSessionName && pi.getSessionName()) || (ctx.sessionManager.getSessionName && ctx.sessionManager.getSessionName())) return;
    const sessionId = ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile && ctx.sessionManager.getSessionFile();
    if (!sessionId || !ctx.model) return;
    const attempted = (ctx.sessionManager.getEntries ? ctx.sessionManager.getEntries() : []).some(entry =>
      entry && entry.type === "custom" && entry.customType === ATTEMPT);
    if (attempted) return;
    const seed = seedFrom(Array.isArray(event.messages) ? event.messages : []);
    if (!seed) return;

    const ownGeneration = generation;
    const model = ctx.model;
    const modelKey = String(model.provider || "") + "/" + String(model.id || model.model || "");
    pi.appendEntry(ATTEMPT, { model: modelKey, startedAt: new Date().toISOString() });
    const aborter = new AbortController();
    controller = aborter;
    const timer = setTimeout(() => aborter.abort(), TIMEOUT_MS);
    void (async () => {
      try {
        const request = { messages: [{
          role: "user",
          content: [{ type: "text", text: "请为这段会话生成一个简短明确的中文标题。只输出标题，不加引号、前缀或解释；最多20个汉字。\\n\\n用户请求：" + seed.user + "\\n\\n助手结果：" + seed.assistant }],
          timestamp: Date.now(),
        }] };
        let response;
        if (typeof ctx.modelRegistry.complete === "function") {
          // Do not inherit the chat's high thinking level. Api-specific complete()
          // treats an omitted reasoningEffort as thinking disabled where supported.
          response = await ctx.modelRegistry.complete(model, request, { maxTokens: MAX_OUTPUT_TOKENS, signal: aborter.signal });
        } else {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth || !auth.ok || !auth.apiKey || aborter.signal.aborted) return;
          const complete = await loadComplete();
          response = await complete(model, request, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: MAX_OUTPUT_TOKENS, signal: aborter.signal });
        }
        if (response && response.stopReason && !["stop", "length"].includes(response.stopReason)) return;
        if (response && response.errorMessage) return;
        const title = normalizeTitle(responseText(response));
        if (!title || aborter.signal.aborted || generation !== ownGeneration) return;
        if ((ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId()) !== sessionId) return;
        if ((ctx.sessionManager.getSessionFile && ctx.sessionManager.getSessionFile()) !== sessionFile) return;
        if ((pi.getSessionName && pi.getSessionName()) || (ctx.sessionManager.getSessionName && ctx.sessionManager.getSessionName())) return;
        pi.setSessionName(title);
        if (ctx.ui && typeof ctx.ui.setStatus === "function") {
          ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ sessionId, sessionFile: sessionFile || null, title }));
        }
      } catch { /* Offline/auth/provider failure leaves Pi's existing fallback intact. */ }
      finally { clearTimeout(timer); if (controller === aborter) controller = null; }
    })();
  });
}
`;

function joinFsPath(base: string, child: string): string {
	const b = base.replace(/\\/g, "/").replace(/\/+$/, "");
	const c = child.replace(/\\/g, "/").replace(/^\/+/, "");
	return b ? `${b}/${c}` : c;
}

async function resolveGlobalExtensionsRoot(): Promise<string | null> {
	const { homeDir } = await import("@tauri-apps/api/path");
	const home = (await homeDir()).replace(/\\/g, "/").replace(/\/+$/, "");
	return home ? joinFsPath(joinFsPath(joinFsPath(home, ".pi"), "agent"), "extensions") : null;
}

export interface SessionTitleExtensionInstallResult {
	path: string;
	created: boolean;
	updated: boolean;
	skipped: boolean;
	error?: string;
}

export async function ensureSessionTitleExtensionInstalled(): Promise<SessionTitleExtensionInstallResult> {
	const root = await resolveGlobalExtensionsRoot();
	if (!root) return { path: "", created: false, updated: false, skipped: true, error: "Could not resolve home directory" };
	const extensionPath = joinFsPath(root, SESSION_TITLE_EXTENSION_FILE);
	try {
		const { exists, mkdir, readTextFile, writeTextFile } = await import("@tauri-apps/plugin-fs");
		await mkdir(root, { recursive: true });
		const hasExisting = await exists(extensionPath);
		const existing = hasExisting ? await readTextFile(extensionPath).catch(() => "") : "";
		if (existing.replace(/\r\n/g, "\n").trim() === SESSION_TITLE_EXTENSION_CONTENT.trim()) {
			return { path: extensionPath, created: false, updated: false, skipped: false };
		}
		if (hasExisting && existing.trim() && !existing.includes(SESSION_TITLE_EXTENSION_MARKER_PREFIX)) {
			return { path: extensionPath, created: false, updated: false, skipped: true, error: "Skipped writing session-title extension because the file is user-managed." };
		}
		await writeTextFile(extensionPath, SESSION_TITLE_EXTENSION_CONTENT);
		return { path: extensionPath, created: !hasExisting, updated: hasExisting, skipped: false };
	} catch (error) {
		return { path: extensionPath, created: false, updated: false, skipped: false, error: error instanceof Error ? error.message : String(error) };
	}
}
