# Multi-CLI támogatás: Claude Code, OpenAI Codex és Google Antigravity

> Lehetővé teszi, hogy a Marveen ügynök-flotta és a háttér-worker sessionök a **Claude Code (`claude`)** mellett natívan fussanak **OpenAI Codex (`codex`)** és **Google Antigravity (`agy`)** CLI-ken is — 100%-ban dinamikus modellfelderítéssel, közös tmux vezérléssel és szigorú hitelesítőadat-izolációval.

---

## 🎯 Mit tud / miért érdekes

A Marveen eredetileg kizárólag a Claude Code CLI-re épült. A Multi-CLI réteg kiterjeszti a teljes ügynök-életciklust (indítás, tmux TUI állapotfelismerés, üzenet-injektálás, liveness-figyelés, aktív modell kiolvasás és beszélgetés-idővonal) három natív parancssori AI ügynökre:

1. **Claude Code (`claude`)** — Anthropic modellek, OpenRouter és egyéni (`/v1/messages`) providerek.
2. **OpenAI Codex (`codex`)** — OpenAI modellek a helyi Codex CLI-ből (PATH-ból vagy a macOS `ChatGPT.app` beépített `codex` binárisából).
3. **Google Antigravity (`agy`)** — Google Antigravity CLI által kínált modellek.

### Főbb jellemzők

- **100% dinamikus modellkatalógus (nincs beégetett modell-lista):** A rendszer a gépen telepített `codex` és `agy` környezetből valós időben olvassa ki az elérhető modelleket, és csak akkor jeleníti meg a csoportokat a Dashboard Modell-választójában, ha az adott CLI-ből ténylegesen olvashatók modellek.
- **Vegyes flotta:** Egyetlen Marveen-példányon belül az egyik ügynök futhat `claude`-on, a másik `codex`-en, a harmadik pedig `agy`-n.
- **Egységes utasításfájlok (`CLAUDE.md` → `AGENTS.md` / `GEMINI.md`):** Indítás előtt a rendszer automatikusan szimbolikus linket készít az ügynök munkakönyvtárában található `CLAUDE.md`-re `AGENTS.md` és `GEMINI.md` néven, így mindhárom CLI ugyanazt a személyiséget és szabályrendszert olvassa fel.
- **Zéró credential-szivárgás:** Nem-Claude CLI (`codex` vagy `agy`) indításakor a rendszer minden indítási útvonalon (helyi ügynök, háttér-worker, távoli SSH tmux) törli (`unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY`) az örökölt Anthropic hitelesítő adatokat.

---

## 🛠 Hogyan működik

### 1. Moduláris CLI Provider Adapter Architektúra (`src/cli-providers.ts` & `src/cli-detector.ts`)

A CLI-specifikus viselkedés nem szóródik szét a kódbázisban: minden támogatott parancssori ügynök egy önálló **`CliProviderAdapter`** objektumként van regisztrálva a `registerCliProvider()` függvénnyel a `src/cli-providers.ts`-ben.

Egy adapter egyetlen helyen definiálja az adott CLI összes tulajdonságát:
- `id`, `displayName`, `binaryName`, `fallbackBinaryPaths`
- `modelPrefixes` (pl. `['codex:', 'openai:']`) és `matchesModelFamily(lowerModelId)`
- `instructionFiles` (pl. `['AGENTS.md']`, `['GEMINI.md', 'AGENTS.md']`)
- `supportsClaudeChannelsFlag`, `supportsSlashRename`, `supportsSlashClear`
- `discoverModels()` — dinamikus modellkatalógus-kiolvasás
- `stampWorkspaceTrust(dir)` — munkakönyvtár előzetes megbízhatóvá tétele (`0o600` jogosultsággal)
- `findTranscript(workingDir, homeDir)` — a munkakönyvtárhoz tartozó legfrissebb `.jsonl` munkamenet-napló megkeresése
- `parseTranscriptLine(entry, clipText)` — egységes modell-, kontextustoken-, aktivitás- (`isTurnActivity`), idővonal- (`timelineItems`) és élő naplóesemény- (`transcriptEvents`) kinyerés

> **Új CLI ügynök hozzáadása a jövőben:** Ha később egy negyedik CLI ügynököt (pl. `opencode`, `aider`, `goose`, `qwen-code`) szeretnél bekötni, elegendő egy új `CliProviderAdapter` objektumot regisztrálni a `registerCliProvider()` hívással a `src/cli-providers.ts`-ben — a teljes rendszer (`active-model`, `agent-transcript`, `agent-conversation`, `context-restart-gate`, `schedule-runner`, `agent-process`, `agent-worker`) automatikusan támogatni fogja.

A `getCliTypeForModel(model)` függvény az alábbi sorrendben választja ki a megfelelő adaptert:

1. **Explicit előtagok:** `codex:<id>` / `openai:<id>` → `codex`; `agy:<id>` / `antigravity:<id>` → `agy`; `claude:<id>` → `claude`.
2. **OpenRouter formátum (`provider/model`):** mindig `claude` (Anthropic-kompatibilis végponton keresztül).
3. **Dinamikusan felderített katalógusok:** a regisztrált providerek `discoverModels()` hívása által betöltött modellazonosítók.
4. **Családminták (`matchesModelFamily`):** `gemini-*`, `antigravity-*` → `agy`; `gpt-*`, `o1*`, `o3*`, `o4*`, `codex*` → `codex`; minden egyéb → `claude`.

### 2. Dinamikus modellfelderítés

A `GET /api/models/available` végpont (valamint a Dashboard modellválasztója) semmilyen statikus `codex` vagy `agy` modell-listát nem tartalmaz:

- **Codex (`getCodexAvailableModels`):**
  - Beolvassa a `$CODEX_HOME/models_cache*.json` (alapértelmezetten `~/.codex/models_cache.json`) fájlokat, kiszűri a `visibility === 'list'` modelleket, és kanonikus **`codex:<model>`** azonosítóval regisztrálja őket (`rawId` + `cli: 'codex'` metaadattal).
  - Emellett ellenőrzi a `~/.codex/config.toml` fájlban beállított alapértelmezett `model = "..."` értéket.
- **Antigravity (`getAgyAvailableModels`):**
  - Meghívja az `agy models` parancsot (`execFileSync`), és feldolgozza a TTY `\r` spinner-sorok megtisztítása után a többszóközös/tabulátoros (`<id>   <Display Name>`) és a felsorolásos (`• <Display Name> (<id>)`) kimenetet is.
  - Kanonikus **`agy:<model>`** azonosítót állít elő, így az Antigravity által is kínált átfedő modellek (pl. `agy:claude-opus-5-5-high` vs natív `claude-opus-4-6`, vagy `agy:gpt-oss-120b-medium` vs `codex:gpt-5.4`) ütközésmentesen elkülönülnek a kártyákon (`Antigravity · ...`, `Codex · ...`) és a modellválasztóban.
  - Kiegészítésként beolvassa a `~/.gemini/antigravity-cli/settings.json` `model` mezőjét is.

### 3. Munkakönyvtár-előkészítés és Workspace Trust (`prepareWorkspaceForCli`)

Ahhoz, hogy a felügyelet nélkül (tmux-ban) induló ügynökök ne akadjanak el interaktív jóváhagyási ablakokon:

- **Utasítás-symlinkek:** Ha az ügynök könyvtárában létezik reguláris `CLAUDE.md`, létrejön rá a relatív `AGENTS.md` és `GEMINI.md` symlink.
- **Codex trust stamp (`stampCodexWorkspaceTrust`):** A `~/.codex/config.toml` fájlba bejegyzi a munkakönyvtárat és annak git-gyökerét `trust_level = "trusted"` értékkel.
- **Antigravity trust stamp (`stampAgyWorkspaceTrust`):** A `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces` tömbjébe felveszi a munkakönyvtárat és a git-gyökeret.

### 4. Tmux TUI állapotfelismerés és üzenetküldés (`src/pane-state.ts`)

A Marveen a tmux-panel szöveges tartalmát (`capture-pane`) elemzi, hogy tudja, mikor szabad (`idle`), mikor gépel (`typing`), mikor dolgozik (`busy`), és mikor vár első indítási jóváhagyásra (`firstRunGate`) az ügynök:

| Funkció | Claude Code (`claude`) | OpenAI Codex (`codex`) | Google Antigravity (`agy`) |
|---------|------------------------|------------------------|----------------------------|
| **Idle prompt** | `❯` keretezett bemeneti doboz | `›` (`\u203a`) prompt a státuszsor felett | `>` keretezett bemeneti doboz `<mód> · <Modell>` lábléccel |
| **Busy jelzés** | `esc to interrupt` a láblécben / spinner | `• Working (... • esc to interrupt)` vagy `tab to queue message` | `esc to cancel` a láblécben |
| **First-run kapu** | Workspace trust / Bypass permissions modal | `Do you trust the contents of this directory?` | Workspace trust / Terms of Service / Telemetry modal |
| **Folyamatos munkamenet** | `--continue` | `resume --last` | `--continue` |

### 5. Liveness, aktív modell és beszélgetés-történet

- **Folyamat-felismerés (`src/channel-coordinator/liveness.ts`):** A `getClaudePidForSession()` a `claude` mellett a `codex` és `agy` gyermekfolyamatokat (valamint az `agy` által indított Node.js wrapper folyamatokat) is felismeri a tmux panel folyamatfájában.
- **Aktív modell és naplók (`src/web/active-model.ts`, `src/web/routes/agent-conversation.ts`):**
  - **Antigravity:** A `~/.gemini/antigravity-cli/cache/last_conversations.json` alapján megkeresi a munkakönyvtárhoz tartozó `~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl` fájlt, és feldolgozza a `USER_INPUT` / `PLANNER_RESPONSE` bejegyzéseket.
  - **Codex:** A `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` fájlok `session_meta` (`payload.cwd`) fejléce alapján megkeresi a legfrissebb munkamenetet, és feldolgozza a `turn_context` (aktív modell) és `response_item` (üzenetek és eszközhívások) bejegyzéseket.

---

## 🔒 Biztonsági garanciák

1. **CLI Flag / Argument Injection védelem (`SAFE_MODEL_ID_RX`):**
   - Minden modellazonosító átmegy a `^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$` ellenőrzésen.
   - A `-` jellel kezdődő értékeket (pl. `--dangerously-...`, `-c ...`), szóközt, idézőjelet, vezérlőkaraktert vagy shell-metakaraktert tartalmazó bemeneteket a `stripCliModelPrefix()` azonnal elutasítja, és minden CLI-indításnál külön POSIX egyszeres idézőjelezést (`shSingleQuote` / `shArg`) alkalmaz.
2. **Path Traversal és Symlink védelem (`SAFE_CONV_ID_RX`):**
   - A `last_conversations.json`-ből származó `convId` kizárólag `^[a-zA-Z0-9_-]{1,128}$` formátumú lehet (a `../` vagy `/` karaktereket tartalmazó értékeket a rendszer eldobja).
   - Mind a naplófájlok olvasásakor, mind a `~/.codex/config.toml` és `~/.gemini/antigravity-cli/settings.json` írásakor a rendszer ellenőrzi az `!lstatSync(path).isSymbolicLink()` feltételt, megakadályozva a symlink-alapú fájlfelülírást vagy jogosulatlan fájlolvasást.
3. **Szigorú jogosultságok (`0o600` / `0o700`):**
   - A `stampCodexWorkspaceTrust` és `stampAgyWorkspaceTrust` által létrehozott/módosított konfigurációs fájlok mindig `0o600` (a szülőkönyvtárak `0o700`) jogosultsággal íródnak.
4. **Hitelesítő adatok izolációja (`unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY`):**
   - Ha egy ügynök vagy worker `codex` vagy `agy` modellel indul, a rendszer kiüríti az egyéni Anthropic provider változókat, és a shellben kifejezetten törli (`unset`) a `CLAUDE_CODE_OAUTH_TOKEN` és `ANTHROPIC_API_KEY` környezeti változókat helyi, worker és távoli SSH indításnál egyaránt.
5. **Szigorú profil (`permissionMode === 'strict'`) tiszteletben tartása:**
   - Ha az ügynök biztonsági profilja `strict`, a `codex` nem kapja meg a `--dangerously-bypass-approvals-and-sandbox` kapcsolót (helyette `--sandbox workspace-write` módban fut), az `agy` pedig nem kapja meg a `--dangerously-skip-permissions` zászlót.

---

## ⚡ Automatikus Headroom AI optimalizálás

A Marveen natívan integrálja a [Headroom](https://github.com/headroomlabs-ai/headroom) kontextus- és token-optimalizáló réteget mindhárom CLI-hez (`claude`, `codex`, `agy`):

- **Automatikus telepítés (`scripts/install-headroom.sh`):** A `install-macos.sh`, `install-linux.sh` és `update.sh` automatikusan telepíti/frissíti a `headroom-ai` csomagot (`uv tool install` előnyben részesítve, ennek hiányában izolált Python ≥ 3.10 venv `~/.local/share/marveen-headroom-venv` alatt `~/.local/bin/headroom` szimlinkkel). Kikapcsolható a `MARVEEN_HEADROOM=0` környezeti változóval.
- **Transzparens indítási csomagolás (`headroom wrap`):** Ha a `headroom` elérhető a gépen, a fő munkamenet (`scripts/channels.sh`), a helyi alügynökök (`agent-process.ts`) és a háttér-workerek (`agent-worker.ts`) automatikusan `headroom wrap <cli> --` parancson keresztül indulnak (kivéve `claude` egyéni OpenRouter/DeepSeek `ANTHROPIC_BASE_URL` esetén, hogy a külső végpont ne ütközzön).
- **MCP regisztráció (`headroom mcp serve`):** A `prepareWorkspaceForCli` és a worker indítás automatikusan regisztrálja a `headroom mcp serve` MCP-szervert a megfelelő konfigurációba (`claude`: `.mcp.json`, `codex`: `~/.codex/config.toml` `[mcp_servers.headroom]`, `agy`: `~/.gemini/antigravity/mcp_config.json`) szimlink-védelemmel, `0o600` jogosultsággal és az API-kulcsokat / tokeneket kiszűrő `env` másolással.
- **Folyamatkövetés (`liveness.ts` & `channels.sh`):** A watchdog és a channel monitor a `headroom` wrapper folyamaton keresztül is automatikusan megtalálja az alatta futó `claude`/`codex`/`agy` gyermekfolyamatot.
- **Diagnosztika (`GET /api/models/available`):** A válasz `headroom` objektumban (`available`, `enabled`, `binPath`, `version`, `wrapTargets`) jelzi a Headroom állapotát.

---

## 🧠 Codex / Antigravity mint fő orchestrator (Marveen — Claude Code nélkül)

A Codex (`codex:*`) és a Google Antigravity (`agy:*`) nemcsak alügynökként vagy worker-ként, hanem teljes értékű **fő orchestratorként** is futtatható Claude Code telepítése vagy előfizetése nélkül:

- **Váltás Dashboardról vagy `.env`-ből:** A Marveen részletező panel Beállítások fülén (`PUT /api/marveen/model`) közvetlenül átállítható a fő orchestrator modell (`MAIN_AGENT_MODEL`), és a szolgáltatás újraindul az új CLI-vel.
- **Teljes Telegram kétirányú kapcsolat Claude `--channels` nélkül:**
  - **Bejövő (`marveen-channel-coordinator`):** Amikor a fő munkamenet `codex` vagy `agy`, a `decideHasPluginAlive()` felismeri, hogy nincs natív Claude plugin, ezért a koordinátor automatikusan átveszi a Telegram `getUpdates` pollingot és `[CHANNEL-INBOUND]` formában injektálja a gazda üzeneteit az orchestrator tmux paneljébe.
  - **Kimenő (`scripts/channel-reply-mcp.mjs` → `telegram_reply`):** A `syncCliMcpConfig()` automatikusan beregisztrálja a zéró-titok stdio `marveen_telegram` MCP-szervert a Codex `~/.codex/config.toml` és az Antigravity `~/.gemini/antigravity/mcp_config.json` konfigurációjába (a `TELEGRAM_BOT_TOKEN` futásidőben kizárólag a Node-folyamaton belül olvasódik ki, nem kerül sem config-fájlba, sem parancssori argumentumokba).
- **Claude-mentes telepítés (`install-macos.sh`, `install-linux.sh`):**
  - A telepítő automatikusan felderíti a gépen található CLI-ket (`claude`, `codex`, `agy`), kilistázza az adott CLI-hez elérhető modelleket (`.codex/models_cache*.json`, `agy models`, stb.), és lehetővé teszi a **fő orchestrator CLI és modell** (`MAIN_AGENT_MODEL`) közvetlen kiválasztását (vagy környezeti változóval: `MARVEEN_ORCHESTRATOR=codex|agy`, `MARVEEN_MAIN_MODEL=...`).
  - Telegram csatorna választásakor közvetlenül a telepítés során megadható a **Bot API Token** (`MARVEEN_TELEGRAM_BOT_TOKEN`) és az **Engedélyezett Telegram Chat ID** (`MARVEEN_ALLOWED_CHAT_ID`), amivel az `.env` és az `access.json` azonnal `allowlist` módba kerül.
- **Teljes Dashboard UI paritás (`Ügynökök → Marveen` és minden alügynök `Csatorna` füle):**
  - A Telegram Bot Token, opcionális Chat ID(k), új Chat/Csoport ID kézi hozzáadása (`POST /api/agents/:name/channels/:provider/allowed`) és az élő Bot Token cseréje a meglévő chat-ek megtartásával közvetlenül a Dashboard UI-ról is elvégezhető mind a fő orchestratorra, mind minden alügynökre.
