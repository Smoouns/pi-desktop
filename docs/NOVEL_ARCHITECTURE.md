# Novel Desktop Architecture

## Scope

Pi Desktop remains a three-layer host:

```text
Desktop Host (Lit + Tauri)
    <-> Pi RPC bridge
Pi Runtime (pi --mode rpc)
    <-> Packages / Extensions / Skills
```

The first novel phase adds a local-first domain layer without copying or changing the Pi runtime. The first release focuses on stable Markdown editing, filesystem-backed novel navigation, and an inspectable deterministic context builder. Chapter planning, review, acceptance, and Canon promotion remain ordinary Markdown workflows until a later phase.

## Ownership

### Generic host retained

- Workspace and project persistence
- Session tabs, RPC, streaming, provider/model/auth handling
- Existing file tree, file tabs, editor, terminal, dialogs, and extension UI bridge
- Generic filesystem abstraction and Tauri permissions

### Novel-owned domain

`src/novel/` owns project metadata, legacy layout mappings, path safety, category scanning, document classification, and context policy. Novel UI owns navigator and context inspector presentation. Agent reasoning remains in Pi and packages/extensions.

Upstream-sensitive files are `src/main.ts`, `src/components/sidebar.ts`, `src/components/file-viewer.ts`, `src/rpc/bridge.ts`, and Tauri capability files. Novel-owned additions should be isolated and generic modifications should remain narrow and intentional.

## File model

Projects use a content-type plus lifecycle/authority model. Content types include `manuscript`, `canon`, `planning`, `draft`, `craft`, `note`, `research`, `memory`, `archive`, `asset`, and `export`. Authority values include `canonical`, `approved`, `proposed`, `draft`, `historical`, `derived`, `reference`, and `external-reference`.

Directory names are defaults, not proof of authority. `.novel/project.json` may declare `layout` and explicit authority entry points for a legacy project. A Canonical Text Index can mark a file under `drafts/` as canonical prose. Markdown remains the source of truth; the app does not maintain a duplicate content database.

Initialization is non-destructive: it creates missing metadata/directories only and never moves or overwrites existing files. Imported legacy projects use an external manifest with source path, target path, hash, classification, and reason.

## Context Engine

`src/novel/context.ts` builds a per-request `ContextItem[]` using a deterministic policy. The active document and pinned documents come first, followed by selected entities, adjacent canonical manuscript, explicit prompt mentions, relevant planning/current-state records, and craft/style references. Historical, archived, and proposed files are excluded unless explicitly selected or pinned.

Each item contains `path`, `contentType`, `authority`, `reason`, `estimatedTokens`, `priority`, and `pinned`. The inspector exposes these choices to the user. Context is request-scoped and is not permanently appended to the Pi system prompt.

## Canon safety and workflow phase 2

Canon is author-controlled. The app may read Canon and help formulate suggestions, but no agent action can silently mutate it. The chapter workflow uses explicit, auditable transitions:

```text
chapter card -> user confirms card -> candidate draft
    -> user accepts manuscript -> confirmed Canon promotion
    -> or user requests revision -> agent revision -> user review again
```

The workflow projection discovers chapter cards, proposed candidates, continuity proposals, revision requests, and canonical manuscript paths from Markdown and `project.json`; it does not create a duplicate content database. `planning/reviews/` is optional planning-agent feedback, not a gate and not required to correspond one-to-one with a manuscript. The user confirms a chapter card before drafting can proceed, then separately confirms a manuscript only after reading it. Confirmations are lightweight `.novel/acceptances/` records containing only paths, content fingerprints, and timestamps. A later change to the confirmed card or manuscript invalidates the corresponding decision. The promotion dialog previews the candidate source, non-overwriting Canon target, and `.novel/promotion-log.md`; existing Canon files are never overwritten.

Either confirmation surface also offers “request revision”. This creates an immutable `planning/revision-requests/<chapter>-<scope>-<timestamp>.md` handoff with the source path, fingerprint, and user feedback. A card revision removes card confirmation and makes its dependent candidate ineligible. A manuscript revision removes only manuscript acceptance. The planning agent owns chapter cards, event outlines, reviews, and revision handoffs; the writing agent owns candidate prose and its `Continuity Proposal`; the worldbuilding agent owns Canon setting documents. Agents do not advance user-owned decisions themselves.

The workflow state is a view, not an authority: source Markdown and the user's explicit action remain authoritative. Chat and Context Builder cannot invoke confirmation or promotion. The writing agent emits a `Continuity Proposal` beside the candidate, describing facts that actually reached the prose and, optionally, a strict `<!-- novel-record-updates ... -->` JSON block. This is the writing-to-planning handoff: after user acceptance, the planning agent can read the proposal and current state without rereading the full manuscript. Each optional update names one supported target (`current-state`, `continuity-ledger`, or `progress`) and either exact text to append or a `replace-once` operation with a unique exact anchor and replacement. The promotion dialog previews each item as an addition or `- before / + after` replacement, lets the user deselect it, and rechecks the target content fingerprint before writing. A missing, repeated, or changed anchor, or any change after preview, fails closed. Promotion prepares all selected file changes before creating Canon; a later write failure rolls back already-written associated files and removes the newly created Canon target. Natural-language proposal content is never interpreted as an edit instruction.

Deterministic verification reports are separate Markdown records under `planning/verifications/` (or an explicitly named `*-verification.md` file). `planning/reviews/` remains optional planning-agent feedback and is never treated as the verification report or as a one-to-one manuscript gate.

The extension also exposes four optional prompt-prefill commands: `/novel-world`, `/novel-plan`, `/novel-write`, and `/novel-review`. They only place a role-bounded template in the editor and never submit it. Worldbuilding remains Canon-read/proposal-only; planning owns event outlines, chapter cards, and user-requested reviews; writing owns candidate prose and its Continuity Proposal; review mode is feedback-driven and is not a manuscript gate.

Each successful promotion also writes a private `.novel/promotion-history/<id>.json` snapshot, recording the Canon fingerprint and full before/after text plus fingerprints for every selected associated-record patch. A promoted chapter exposes a separate, user-confirmed rollback only while the matching active history entry exists. Before it writes anything, rollback checks that the Canon file and all associated records exactly match their post-promotion fingerprints. It then restores the recorded pre-promotion texts, removes only the Canon file created by that promotion, marks the history entry as rolled back, and appends an audit line. Any later manual edit, missing file, invalid history, or write failure rejects the operation rather than overwriting content; an in-progress rollback restores its own partial changes. Manuscript acceptance remains intact, so a rolled-back chapter can be promoted again through the normal confirmation flow.

## World-change history and rollback

Worldbuilding changes have an independent author-owned review flow in `world-change.ts` and `world-change-dialog.ts`. Requests and complete replacement proposals remain under `planning/world-proposals/`; accepted changes record exact before/after text and fingerprints in `.novel/world-change-history/` and append to `.novel/world-change-log.md`. Consumed proposals, including rolled-back changes, are hidden from pending review but retained as evidence.

History rollback requires a second explicit confirmation after preview. It restores only the selected Canon file, leaving manuscript, planning and other declared affected files untouched. The latest active change to a file must be rolled back first. Domain code rereads the reviewed history and current target, rejects altered snapshots or later edits, and compensates caught partial-write failures. The host blocks unsaved editor changes and stale-project actions, then invalidates the file preview and refreshes novel/context views. New snapshots bind to the normalized project root; legacy unbound snapshots remain readable after validation. Moving bound history between roots needs a future explicit migration workflow.

This is a guarded local operation, not an OS transaction: abrupt process death, power loss and concurrent external writers are not covered by an atomicity guarantee. Deterministic tests use an in-memory Tauri FS adapter with write-failure injection; the browser harness uses synthetic data only. Native Tauri filesystem integration still requires isolated-project acceptance testing.

## Pi novel tools

On desktop startup, Pi Desktop installs a versioned extension at `~/.pi/agent/extensions/pi-desktop-novel-tools.ts`. It preserves a file that lacks its ownership marker, so a user-managed extension is never overwritten. Pi must be restarted or its runtime reloaded before a newly installed extension becomes available.

The extension is available only when Pi's active working directory contains `.novel/project.json`. It registers seven read-only tools: `list_story_files`, `read_story_document`, `read_chapter`, `read_character`, `read_outline`, `search_story`, and `get_current_document`. All document paths must be project-relative, absolute paths and traversal are rejected, recursive listing/search skips `.git`, `.novel`, `node_modules`, and `dist`, and result sizes are bounded.

`get_current_document` reads the first document supplied in the latest request's `<novel-context>` block. The extension's `context` hook removes these desktop markers from the provider message list and adds the latest selection as a transient, hidden custom message; older request selections are removed from the model context. It does not establish a second persisted "current file" state. These tools cannot write files, create revision requests, change acceptance records, apply patches, promote Canon, or invoke rollback.

## Memory reservation

Four layers are reserved for later work:

- `CANON`: author-confirmed facts.
- `DERIVED`: state inferred from accepted manuscript.
- `SUMMARY`: generated chapter/scene summaries with source provenance.
- `SCRATCH`: disposable agent working memory.

The first phase creates no automatic memory pipeline and must keep generated summaries distinct from Canon.

## Compatibility strategy

- Prefer new `src/novel/` files and thin host adapters.
- Do not change the Pi RPC protocol, session lifecycle, provider/auth code, or generic filesystem contracts.
- Do not format or rewrite unrelated upstream files.
- Keep coding capabilities available for Advanced/debug use.
- The `fate-control-cycle` sample under `fixtures/novel-projects/` is a copied, hash-verified integration fixture; its source project is never modified by the app.
