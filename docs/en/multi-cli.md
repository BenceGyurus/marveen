# Multi-CLI Support: Claude Code, OpenAI Codex, and Google Antigravity

> Run Marveen agents and background workers natively on **Claude Code (`claude`)**, **OpenAI Codex (`codex`)**, and **Google Antigravity (`agy`)** — with 100% dynamic model discovery, unified tmux orchestration, and strict credential isolation.

---

## 🎯 What It Does & Why It Matters

Marveen originally targeted Claude Code exclusively. The Multi-CLI layer extends the full agent lifecycle (session launch, tmux TUI state detection, prompt injection, liveness monitoring, active model tracking, and conversation timeline parsing) across three native command-line AI coding agents:

1. **Claude Code (`claude`)** — Anthropic models, OpenRouter, and custom (`/v1/messages`) providers.
2. **OpenAI Codex (`codex`)** — OpenAI models discovered from the local Codex CLI installation (`PATH` or the macOS `ChatGPT.app` bundled `codex` binary).
3. **Google Antigravity (`agy`)** — Models exposed by the local Google Antigravity CLI (`agy`).

### Key Capabilities

- **100% Dynamic Model Discovery (Zero Hardcoded Model Lists):** Available models are discovered at runtime directly from the installed `codex` and `agy` environments. The Dashboard model selector only displays the Codex or Antigravity `<optgroup>` when models are actually discovered on the host.
- **Mixed Fleet:** Run `claude`, `codex`, and `agy` agents side by side within the same Marveen fleet.
- **Unified Persona & Instructions (`CLAUDE.md` → `AGENTS.md` / `GEMINI.md`):** Before launching an agent, Marveen creates relative `AGENTS.md` and `GEMINI.md` symlinks pointing to `CLAUDE.md` in the workspace so all three CLIs load the same instructions.
- **Zero Credential Leakage:** Whenever a non-Claude CLI (`codex` or `agy`) launches (local agent, background worker, or remote SSH tmux), inherited Anthropic credentials (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) are explicitly stripped via `unset`.

---

## 🛠 How It Works

### 1. Modular CLI Provider Adapter Architecture (`src/cli-providers.ts` & `src/cli-detector.ts`)

CLI-specific behavior is encapsulated in `src/cli-providers.ts` behind the **`CliProviderAdapter`** contract and registered via `registerCliProvider()`.

Each adapter defines in one place:
- `id`, `displayName`, `binaryName`, `fallbackBinaryPaths`
- `modelPrefixes` and `matchesModelFamily(lowerModelId)`
- `instructionFiles` (`['AGENTS.md']`, `['GEMINI.md', 'AGENTS.md']`, etc.)
- `supportsClaudeChannelsFlag`, `supportsSlashRename`, `supportsSlashClear`
- `discoverModels()` — runtime model catalog extraction
- `stampWorkspaceTrust(dir)` — pre-trusting the workspace (`0o600` permissions)
- `findTranscript(workingDir, homeDir)` — locating the newest `.jsonl` transcript for a workspace
- `parseTranscriptLine(entry, clipText)` — unified extraction of active model, context tokens, turn activity (`isTurnActivity`), conversation timeline items, and live transcript events

> **Adding a new CLI agent in the future:** Registering a new agent (e.g. `opencode`, `aider`, `goose`) only requires implementing `CliProviderAdapter` and calling `registerCliProvider()` in `src/cli-providers.ts`.

`getCliTypeForModel(model)` resolves any model identifier in order:

1. **Explicit prefixes:** `codex:<id>` / `openai:<id>` → `codex`; `agy:<id>` / `antigravity:<id>` → `agy`; `claude:<id>` → `claude`.
2. **OpenRouter slugs (`provider/model`):** Routed to `claude` via the Anthropic-compatible endpoint.
3. **Dynamically discovered catalogs:** Checked against models registered by each provider's `discoverModels()`.
4. **Family matchers (`matchesModelFamily`):** `gemini-*`, `antigravity-*` → `agy`; `gpt-*`, `o1*`, `o3*`, `o4*`, `codex*` → `codex`; everything else → `claude`.

### 2. Dynamic Model Extraction

`GET /api/models/available` queries the host dynamically with a 30–60s in-memory cache:

- **Codex (`getCodexAvailableModels`):** Reads `$CODEX_HOME/models_cache*.json` (default `~/.codex/models_cache.json`), filtering for `visibility === 'list'`, plus the default `model = "..."` entry in `~/.codex/config.toml`, emitting canonical **`codex:<model>`** IDs (`rawId` + `cli: 'codex'`).
- **Antigravity (`getAgyAvailableModels`):** Executes `agy models`, strips `\r` spinner frames, and parses space/tab-delimited (`<id>   <Display Name>` / `<id>\t<Display Name>`) and TTY bullet (`• <Display Name> (<id>)`) formats into canonical **`agy:<model>`** IDs (`Antigravity · ...` badges cleanly disambiguating shared names such as `agy:claude-opus-5-5-high` vs native `claude-opus-4-6`), supplemented by `~/.gemini/antigravity-cli/settings.json`.

### 3. Tmux TUI State Machine & Transcripts

- **TUI State Detection (`src/pane-state.ts`):** `detectAltCliInput()` recognizes both Antigravity's framed `>` input box (`auto · <Model>` footer, `esc to cancel` busy state) and Codex's `›` (`\u203a`) prompt (`• Working (... • esc to interrupt)` / `tab to queue message` busy indicators).
- **Liveness (`src/channel-coordinator/liveness.ts`):** `getClaudePidForSession()` matches `claude`, `codex`, and `agy` child processes inside the tmux pane tree.
- **Transcripts & Active Model (`src/web/active-model.ts`, `src/web/routes/agent-conversation.ts`):** Reads Antigravity brain transcripts (`~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl`) and Codex rollout logs (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).

---

## 🔒 Security Architecture

- **CLI Flag / Argument Injection Guard (`SAFE_MODEL_ID_RX`):** Model IDs must match `^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$`. Strings starting with `-` or containing whitespace, quotes, control characters, or shell metacharacters are rejected by `stripCliModelPrefix()`.
- **Path Traversal & Symlink Protection (`SAFE_CONV_ID_RX`):** Conversation IDs read from `last_conversations.json` are validated against `^[a-zA-Z0-9_-]{1,128}$`, and both transcript readers and config stampers verify `!lstatSync(path).isSymbolicLink()`.
- **Strict File Permissions (`0o600`):** Workspace trust updates to `~/.codex/config.toml` and `~/.gemini/antigravity-cli/settings.json` enforce `0o600` file permissions (`0o700` on parent directories).
- **Credential Isolation & Strict Permission Profile:** Non-Claude launches execute `unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY`, and when `profile.permissionMode === 'strict'`, `codex` uses `--sandbox workspace-write` instead of `--dangerously-bypass-approvals-and-sandbox` while `agy` omits `--dangerously-skip-permissions`.

---

## ⚡ Automatic Headroom AI Optimization

Marveen automatically integrates [Headroom](https://github.com/headroomlabs-ai/headroom) across `claude`, `codex`, and `agy`:

- **Bundled Safe Installer (`scripts/install-headroom.sh`):** Invoked by `install-macos.sh`, `install-linux.sh`, and `update.sh`. Prefers `uv tool install headroom-ai[all]` (fallback `headroom-ai[proxy,mcp]`), or creates an isolated Python ≥ 3.10 venv at `~/.local/share/marveen-headroom-venv` symlinked to `~/.local/bin/headroom`. Fails soft offline and can be disabled with `MARVEEN_HEADROOM=0`.
- **Automatic Session Wrapping (`headroom wrap`):** When `headroom` is present and enabled, the main tmux session (`scripts/channels.sh`), local sub-agents (`agent-process.ts`), and background workers (`agent-worker.ts`) launch via `headroom wrap <cli> --` (skipping `headroom wrap claude` when a custom Anthropic Base URL such as OpenRouter/DeepSeek is active).
- **Zero-Secret MCP Registration (`headroom mcp serve`):** `syncCliMcpConfig()` automatically registers `headroom mcp serve` into Claude's `.mcp.json`, Codex's `~/.codex/config.toml` (`[mcp_servers.headroom]`), and Antigravity's `~/.gemini/antigravity/mcp_config.json` with symlink refusal, `0o600` file permissions, and secret/token stripping for forwarded MCP server env vars.
- **Process Tree Liveness (`liveness.ts` & `scripts/channels.sh`):** Watchdog and channel liveness checks traverse through `headroom` wrapper parent PIDs to track the underlying `claude`/`codex`/`agy` child processes.
- **Status Exposure (`GET /api/models/available`):** Includes a `headroom` object (`available`, `enabled`, `binPath`, `version`, `wrapTargets`).

---

## 🧠 Running Codex or Antigravity as Main Orchestrator (No Claude Code Required)

Both OpenAI Codex (`codex:*`) and Google Antigravity (`agy:*`) can operate not only as sub-agents or background workers, but as the **main Marveen orchestrator** even on hosts without Claude Code installed:

- **Dashboard & `.env` Switcher:** Choose any `claude`, `codex:*`, or `agy:*` model directly from the Marveen Settings tab (`PUT /api/marveen/model`), which updates `MAIN_AGENT_MODEL` in `.env`, prepares workspace trust/MCP configs, and restarts the main session.
- **Bidirectional Telegram Without Claude `--channels`:**
  - **Inbound (`marveen-channel-coordinator`):** `decideHasPluginAlive()` detects when `codex` or `agy` leads the main tmux pane and activates coordinator backfill polling so incoming Telegram messages arrive as `[CHANNEL-INBOUND]` prompts.
  - **Outbound (`scripts/channel-reply-mcp.mjs` → `telegram_reply`):** `syncCliMcpConfig()` automatically registers the zero-secret `marveen_telegram` stdio MCP server in `~/.codex/config.toml` and `~/.gemini/antigravity/mcp_config.json` (reading `TELEGRAM_BOT_TOKEN` internally inside Node from `.env`/state dirs without exposing secrets in configs or argv).
- **Claude-Free Installers (`install-macos.sh`, `install-linux.sh`):** Interactive selection (or `MARVEEN_ORCHESTRATOR=codex|agy`) allows installing Marveen with Codex or Antigravity as the primary CLI while skipping Claude Code install and OAuth requirements.
