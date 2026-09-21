# Context budget research

This note records the evidence behind Pi Desktop's context-budget estimates. It
does not claim that a local estimate is a provider tokenizer or a provider's
enforced capacity.

## Capacity provenance

The active local custom-model entry (anonymized here as `custom-proxy/flash-high`,
not a usable model configuration)
originally used an OpenAI-compatible provider and omitted both `contextWindow` and
`maxTokens`. No credential or endpoint is reproduced here. The installed
`@earendil-works/pi-coding-agent@0.84.2` fills omitted values with 128,000 and
16,384 in:

`<global npm root>/@earendil-works/pi-coding-agent/dist/core/provider-composer.js`

Those numbers are Pi fallback configuration, not capacity metadata returned by
the provider. A read-only authenticated `GET /models` against the already
configured local endpoint listed the alias, but supplied no input/output token
limits; model-detail lookup was unavailable. No generation request was made.

Google's official model page documents the exact Google model code
`gemini-3.8-flash` with a 1,048,576-token input limit and a 65,536-token output
limit:

- <https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash>
- <https://ai.google.dev/gemini-api/docs/models>

The local custom-model name is a proxy-specific alias. The official
capacity therefore must not be silently copied to that alias. Capacity shown to
the user should carry provenance such as `configured`, `provider_metadata`,
`official_base_model_inferred`, or `fallback_default`. The safe resolution is
provider metadata or an explicit user configuration confirmed against the
proxy's contract. An inferred value must remain visibly uncertain and retain
runtime overflow recovery.

Google's official Models API exposes token limits for supported direct models,
and its token API can count a complete request including system instructions
and tools:

- <https://ai.google.dev/api/models>
- <https://ai.google.dev/gemini-api/docs/tokens>
- <https://ai.google.dev/api/tokens>

Calling `countTokens` still transmits the complete request to a service. It is
not a privacy-free local operation, and the current OpenAI-compatible proxy did
not advertise this endpoint.

## Estimation model

The installed Pi implementation in
`dist/core/compaction/compaction.js` estimates approximately
`ceil(characters / 4)` and prefers actual usage from the latest assistant
response when available. Upstream source and custom-model configuration are:

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts>
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md>

Pi Desktop uses a dependency-free estimate for unknown/custom provider aliases:

- ASCII: one estimated token per three serialized characters.
- CJK unified ideographs: two estimated tokens per character.
- Other non-ASCII text: two thirds of its serialized UTF-8 byte count.
- Complete serialized request: an additional 5% safety slack.

The estimator covers the complete JSON payload, including system prompt, tool
schemas, history, checkpoints, observation previews, new evidence, and JSON
structure. Component allocation uses cumulative rounding so the numeric ledger
conserves exactly:

`inputEstimate + outputReserve + safetyMargin = total`

`rawInputBytes` is retained separately as an exact serialization measurement.
Read and tool-output budgets continue to use exact bytes and are not relabeled
as tokens.

The constants are deliberately conservative for multilingual fiction and avoid
the previous dimensional error of comparing every UTF-8 byte directly with a
token window. They are not a hard upper bound, not model-specific, and not a
substitute for actual provider usage or token counting. JSON escaping, model
tokenizer revisions, image accounting, and proxy-added prompts can all change
the final count. Unsupported media and invalid serialization therefore remain
fail-closed. Calibration should compare estimates with sanitized actual usage,
partitioned by model/provider and language mix, before constants are relaxed.

## Safe evidence order

Prefer evidence in this order:

1. actual usage returned for the exact completed provider request;
2. provider token counting for the exact model and complete request;
3. a matching local tokenizer;
4. the explicitly labelled multilingual estimate above.

Actual usage must not be invented for requests that never reached or completed
at the provider. Raw provider prompts, credentials, headers, and full private
endpoints must not be persisted in diagnostics.

## Compaction lifecycle boundary

Implemented policy (managed extension v15):

- Before an idle explicit submission, rebuild the active Pi branch (not the full
  transcript), include the pending input, checkpoint, system prompt and tools.
- At 85% projected total budget, shrink old text-only tool results in a request
  copy. Keep the latest four results and results for pending write tools; retain
  call IDs, message order and errors. Original session files remain unchanged.
- If pressure remains, respect Pi's compaction-enabled setting and await one
  `ctx.compact` callback. Do not inject a new user message or replay any tool.
- On error or remaining overflow, restore the visible unsent request to the
  editor and stop. Session/model changes fence callbacks. During a live loop,
  rely on native Pi compaction; never invoke manual compact from a context or
  tool hook because it aborts active work.
- Native before/after-compaction hooks persist and revalidate checkpoints.
  Unresolved write outcomes cancel compaction rather than granting permission
  to replay. Recent tool results are retained for the summarizer.
- Checkpoint request projections reference byte-identical active user messages
  instead of duplicating them; durable constraints remain unchanged, ordered,
  and authoritative. Historical constraints absent from active context stay in
  full. If these alone exceed capacity, this version still blocks: it does not
  semantically discard instructions to make a request fit.
- Skill/template expansion occurs after the input hook, so final context
  preflight is still authoritative. An unexpectedly large expanded skill can
  still be blocked instead of recursively compacting inside the agent loop.
- Inputs containing images bypass this send-time automatic compaction path.
  The current extension UI can restore editor text after a handled failure but
  cannot restore image attachments, so attempting maintenance would risk losing
  an unsent multimodal draft. Such inputs continue untouched through Pi's normal
  path and remain subject to the final media and complete-request budget gates.
  Manual compaction before sending is the safe workaround until Desktop has a
  full text-and-attachments draft restoration API.

The context-use dialog opens from the composer usage ring. It separates Pi's
current-context estimate from the full request budget, lists component costs,
shows capacity provenance and maintenance status, and offers manual compaction.
Refresh uses the registered local `/novel-context-status` command, after checking
that it exists, and `get_session_stats`; neither makes a model call. Manual or
automatic summary compaction does make a model call. Unknown usage after compact
is not displayed as zero.

References for the preserve-pairs / retain-recent / clear-before-summary policy:

- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md>
- <https://platform.claude.com/docs/en/build-with-claude/context-editing>

The repository's pinned compatibility suite uses Pi 0.63.1, while the user's
installed runtime uses Earendil Pi 0.84.2. Native lifecycle checks must be run for
both; type checking or loading the extension alone is not equivalent to testing
the compaction callback path.

Budget preflight should remain fail-closed while allowing one bounded recovery
path: detect estimated overflow, preserve a durable checkpoint, invoke native
compaction, rebuild the complete payload, then re-run the same preflight before
any provider dispatch. A failed, cancelled, stale-generation, or still-oversize
compaction must stop rather than bypass the gate. The retry must be bounded and
must not duplicate writes or silently discard the latest user request.

Manual `/compact` and automatic compaction should share the same durable
checkpoint and post-compaction validation rules. The current-context usage UI
should distinguish estimated input, reserved output, safety margin, configured
window, and capacity provenance; it must not present the estimate as provider
actual usage.

## Read-only projection of the reported session

The following is the historical 128k configuration, before the user-confirmed
capacity and 256K working-window change below.

The persisted diagnostic behind `175781 / 128000` used the previous byte-based
estimator. Its largest components were history (96,570), checkpoint (22,302)
and tool observations (13,471). Eight retained constraints (19,722 UTF-8 bytes)
duplicated active user messages. Duplication alone did not explain the overflow.

A bounded offline read of the same branch reconstructed 45 active messages,
the latest checkpoint and 17 tool results, without loading private extensions,
calling a model or modifying the session. Under the new estimator:

| Projection | Estimated input, excluding live system/tools/evidence/reserves |
| --- | ---: |
| Original checkpoint, no tool trimming | 104,980 |
| Checkpoint references only | 101,797 |
| Four old tool results trimmed only | 79,146 |
| Checkpoint references and tool trimming | 75,963 |

Reusing the prior diagnostic's system/tool/evidence costs plus output reserve
and safety margin yields a hybrid projection of **119,314 / 128,000**. It is
not an exact complete-request replay: live tool schemas and system instructions
were not recoverable from the transcript. Only the new live preflight ledger
can confirm the request fits. No private message text or credentials are
included in this report.

## Verification (2026-09-21)

- Public Harness: 223 cases, three deterministic repetitions, no failures.
  Coverage includes multilingual estimation, component conservation, active
  branches, tool-pair preservation, retained constraints, failure restoration,
  disabled compaction, image bypass and stale session callbacks.
- Pinned Pi 0.63.1: generated extension and native compaction lifecycle, with
  only the summary/provider replaced by synthetic responses. One compaction,
  one original prompt dispatch/persistence, no replay.
- Installed Earendil Pi 0.84.2: `npm run test:context-maintenance:global` loads
  the generated managed extension into a temporary fixture project and uses a
  loopback-only OpenAI SSE server plus a synthetic summary. One native
  compaction, one HTTP request, one persisted original user message. No real
  provider generation request or real API key is used.
- Browser usage-window test: actual Chromium at narrow and wide sizes, no
  horizontal overflow, numeric updates and refresh/compact/toggle controls.
  Control callbacks are test doubles; this is not native Tauri manual acceptance.
- Frontend build, both TypeScript checks and `cargo check` passed. Existing
  frontend chunk/import warnings and an unused Rust setup argument remain.
- Isolated source snapshot: 311 explicitly included files, fresh `npm ci`, all
  seven commands passed (both typechecks, 223-case three-repeat Harness,
  long-horizon scenario, five domain regressions and frontend build). Private
  ignored fixtures were not copied; this was not a committed clean clone.

The user's live provider request and final native Desktop interaction still
require a post-restart check. These results do not claim remote CI, a native
release build, exact tokenizer accuracy or verification of the proxy's capacity.

## User-confirmed capacity and working budget

The user subsequently confirmed a 1M context capacity and 64K maximum output,
and requested a practical 256K cap rather than using the full model window.
Using binary K units, the local configuration now separates:

| Meaning | Tokens | Location |
| --- | ---: | --- |
| Provider context capacity (user confirmed) | 1,048,576 | display-only capabilities sidecar |
| Provider maximum output (user confirmed) | 65,536 | display-only capabilities sidecar |
| Effective Pi working window, total request budget | 262,144 | `models.json` model `contextWindow` |
| Effective per-request maximum output / budget reserve | 16,384 | `models.json` model `maxTokens` |
| Harness safety margin | 4,096 | existing complete-request preflight |

This preserves the previous 16K per-request output allowance; 64K is the
available provider capability, not a target generation length. The total 256K
budget includes output and safety, leaving at most 241,664 estimated input
tokens before the hard gate. At 85% of total budget, managed send-time
maintenance first trims old tool results and, if needed, compacts once.

The installed Pi 0.84.2 and pinned 0.63.1 use the model's effective
`contextWindow` for native compaction. Keeping this at 262,144 prevents native
checks from waiting until 1M. We did not inflate global `reserveTokens` to
simulate a smaller window, since that changes other models and summary output
limits. The exact managed and native trigger formulas differ, as before.

`<Pi agent directory>/pi-desktop-model-capabilities.json` uses version 1 and a
`models` array with `provider`, `id`, `contextWindow`, `maxOutputTokens` and
`source: "user-confirmed"`. It is optional, read-only display metadata, matched
by exact provider/model identity and bounded to 64 KiB. Invalid, ambiguous or
undersized declarations are ignored; missing metadata never increases the
working budget. The dialog labels capability provenance as user confirmed,
not independently verified. This private configuration is not committed.

No provider URL, API-key reference, other model or global compaction setting
was changed. Restart Pi Desktop to reload the model registry and managed
extension. Later changes to the practical budget should edit the effective
model limits, not the declared-capability sidecar.

Follow-up verification: 224 Harness cases x 3 deterministic repetitions, both
TypeScript checks, five domain regression suites, the installed 0.84.2 synthetic
compaction lifecycle and narrow/wide Chromium dialog checks passed. The actual
local model configuration was loaded through Pi 0.84.2 `ModelConfig` and
`composeModelProvider` with networking forbidden, confirming an effective
262,144 / 16,384. Provider generation was not invoked. The earlier 223-case
isolated-source result above is historical; this small follow-up did not repeat
the independent dependency installation.

## Entry discoverability follow-up

The previous 24px ring was wired correctly but had no visible label, low
contrast and a help cursor. A real ChatView/composer browser reproduction
confirmed it could open the window before changing the design. The entry is
now a labelled `上下文用量` button including the ring and percentage; the whole
button is clickable, keyboard-focusable and advertises a dialog. Unknown usage
shows a dash rather than 0%. The bottom controls wrap in narrow panes.

That first entry fixture omitted the separate `ContextInspector` summary
card. It therefore did not establish visibility in the complete app shell.

## Full-shell overlap and right-pane resize follow-up

The full-shell reproduction and Windows desktop inspection found the actual
remaining obstruction: `#context-inspector-pane` was fixed at the bottom-right
and covered the composer usage button. The failing hit-test landed on
`.context-summary-total`, even though the usage button was inside the viewport
and all its clipping ancestors. This was not caused by the long model name.

The reference card now occupies normal layout space in `#session-pane`, below
the chat container and above the terminal. Its detailed workbench remains a
viewport overlay. The usage entry and reference-management entry both remain
visible and independently clickable.

The splitter also still used the old right-file layout assumptions while CSS
fixed the new right-chat width. It now controls `--chat-panel-width`, remembers
the chat width independently, and remains available beside the empty editor.

`npm run test:context-entry-ui` now uses the complete app-shell hierarchy,
real ChatView and ContextInspector, and production CSS. It tests 36 layouts:
300/360/520px chat widths, 520/760/920 window heights, both themes and terminal
on/off. It checks viewport containment, clipping ancestors, hit-testing,
opening/closing both dialogs, and unknown usage. Only stats transport is
replaced; no model is called. The pre-fix failure is recorded under
`artifacts/harness/context-entry-ui/before-summary.json` (local evidence).

Computer Use verification in the running Windows app also confirmed the
visible usage entry, opening/closing its dialog, and narrowing/widening the
chat pane by dragging the divider. No generation or compaction was requested.

## Minimal hover summary

The usage entry now shows only `已用 N / 共计 M tokens` on hover or keyboard
focus. The duplicate native `title` tooltip and the long session-stat list
have been removed. The custom tooltip is positioned 8px above the trigger
and does not intercept pointer input; clicking still opens the detailed
usage dialog. Unknown usage is shown as a dash, not zero.
