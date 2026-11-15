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

### 1. CLI-felismerés és modell-routing (`src/cli-detector.ts`)

A `getCliTypeForModel(model)` függvény dönti el, hogy egy adott modellazonosítót melyik CLI bináris (`claude`, `codex` vagy `agy`) futtasson:

1. **Explicit előtagok:** `codex:<id>` / `openai:<id>` → `codex`; `agy:<id>` / `antigravity:<id>` → `agy`; `claude:<id>` → `claude`.
2. **OpenRouter formátum (`provider/model`):** mindig `claude` (Anthropic-kompatibilis végponton keresztül).
3. **Dinamikusan felderített katalógusok:** a `getCodexAvailableModels()` és `getAgyAvailableModels()` által futásidőben betöltött modellazonosítók halmaza (`knownCodexModelIds`, `knownAgyModelIds`).
4. **Családminták (fallback):** `gemini-*`, `antigravity-*` → `agy`; `gpt-*`, `o1*`, `o3*`, `o4*`, `codex*` → `codex`; minden egyéb → `claude`.

### 2. Dinamikus modellfelderítés

A `GET /api/models/available` végpont (valamint a Dashboard modellválasztója) semmilyen statikus `codex` vagy `agy` modell-listát nem tartalmaz:

- **Codex (`getCodexAvailableModels`):**
  - Beolvassa a `$CODEX_HOME/models_cache*.json` (alapértelmezetten `~/.codex/models_cache.json`) fájlokat, és kiszűri a `visibility === 'list'` modelleket.
  - Emellett ellenőrzi a `~/.codex/config.toml` fájlban beállított alapértelmezett `model = "..."` értéket.
- **Antigravity (`getAgyAvailableModels`):**
  - Meghívja az `agy models` parancsot (`execFileSync`), és feldolgozza mind a nem-TTY tabulátoros (`<id>\t<Display Name>`), mind a TTY felsorolásos (`• <Display Name> (<id>)`) kimenetet.
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
