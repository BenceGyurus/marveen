#!/bin/bash
# PERSONAEN1107 / PERSONAESC1107 (Samu 72702, 72762 (b)): the language of everything the install writes for its agents
# (the persona templates here; the dashboard's managed CLAUDE.md sections through src/web/agent-text-lang.ts) is decided
# ONCE, at the first render, and kept in .env as AGENT_TEXT_LANG=en|hu. Every later render only reads it, so a re-run
# installer or `update.sh --regen-claudemd` never switches the language, and the persona and the managed sections always
# agree. An install without the key (every install from before this) is Hungarian, byte-for-byte as before.
#
#   agent_text_lang <dir>          the key, or hu without it
#   agent_text_lang_decide <dir>   the key if set; else, on a FIRST render (no CLAUDE.md yet), decide from MARVEEN_LANG or
#                                  the install's .lang (en only with the English template there), write the key into
#                                  .env, and print it; an existing install without the key stays hu (nothing written)
#   persona_template <dir> <name> [decide]
#                                  the template path in that language (decide: the first-render callers, i.e. the
#                                  installers and the Docker first-boot; without it: read only, e.g. update.sh)

_atl_trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# The .env line grammar of the TypeScript reader (src/env-parse.ts parseEnvContent), line for line, so the persona and
# the managed sections never disagree on a hand-edited .env (EGM review, Dani 72871 S1): the line is trimmed, blank
# and # lines are skipped, the key is what precedes the FIRST "=", key and value are trimmed, ONE pair of matching
# surrounding quotes is stripped, and the LAST matching line wins. Bash 3.2 safe (no negative substring offsets).
_atl_read() {
  local line key val first last v=""
  [ -f "$1/.env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(_atl_trim "$line")"
    case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
    key="$(_atl_trim "${line%%=*}")"
    [ "$key" = AGENT_TEXT_LANG ] || continue
    val="$(_atl_trim "${line#*=}")"
    first="${val%"${val#?}"}"; last="${val#"${val%?}"}"
    if { [ "$first" = '"' ] && [ "$last" = '"' ]; } || { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
      val="${val#?}"; val="${val%?}"
    fi
    v="$val"
  done < "$1/.env"
  case "$v" in en|hu) printf '%s' "$v" ;; esac
}

# An install rendered English BEFORE the key existed (from develop, after #2596): its CLAUDE.md carries the English
# template's heading. Without this it would turn Hungarian on the next regen (Samu 72862). A Hungarian CLAUDE.md, or
# one without the heading, stays hu. src/web/agent-text-lang.ts renderedEnglish() is the same rule.
_atl_rendered_en() {
  [ -f "$1/templates/en/CLAUDE.md.template" ] || return 1
  if [ -f "$1/AGENTS.md" ] && grep -qx '## Inter-agent communication' "$1/AGENTS.md"; then
    return 0
  fi
  [ -f "$1/CLAUDE.md" ] && grep -qx '## Inter-agent communication' "$1/CLAUDE.md"
}

agent_text_lang() {
  local v
  v="$(_atl_read "$1")"
  if [ -z "$v" ] && _atl_rendered_en "$1"; then v=en; fi
  printf '%s' "${v:-hu}"
}

agent_text_lang_decide() {
  local dir="$1" v lang
  v="$(_atl_read "$dir")"
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  if [ -f "$dir/AGENTS.md" ] || [ -f "$dir/CLAUDE.md" ]; then
    # An existing install: hu, unless it was rendered English; that one gets its key now, so it stays English.
    if _atl_rendered_en "$dir"; then
      [ -s "$dir/.env" ] && [ -n "$(tail -c1 "$dir/.env")" ] && printf '\n' >> "$dir/.env"
      [ -f "$dir/.env" ] && printf 'AGENT_TEXT_LANG=en\n' >> "$dir/.env"
      printf 'en'
    else
      printf 'hu'
    fi
    return 0
  fi
  lang="${MARVEEN_LANG:-}"
  [ -n "$lang" ] || lang="$(head -1 "$dir/.lang" 2>/dev/null | tr -d '[:space:]')"
  if [ "$lang" = en ] && [ -f "$dir/templates/en/CLAUDE.md.template" ]; then lang=en; else lang=hu; fi
  if [ -f "$dir/.env" ]; then
    # A last line without a newline would swallow the key.
    [ -s "$dir/.env" ] && [ -n "$(tail -c1 "$dir/.env")" ] && printf '\n' >> "$dir/.env"
    printf 'AGENT_TEXT_LANG=%s\n' "$lang" >> "$dir/.env"
  fi
  printf '%s' "$lang"
}

persona_template() {
  local dir="$1" name="$2" lang
  if [ "${3:-}" = decide ]; then lang="$(agent_text_lang_decide "$dir")"; else lang="$(agent_text_lang "$dir")"; fi
  if [ "$lang" = en ] && [ -f "$dir/templates/en/$name" ]; then
    printf '%s' "$dir/templates/en/$name"
  else
    printf '%s' "$dir/templates/$name"
  fi
}

# Sync universal cross-agent instruction files inside $1 (<dir>):
# Keep AGENTS.md as the canonical regular file (used by Codex, Antigravity,
# OpenCode, etc.) and link GEMINI.md + CLAUDE.md -> AGENTS.md so every CLI and
# internal reader sees the exact same file without drift.
# Pass "promote-claudemd" as $2 right after rendering into CLAUDE.md so the
# freshly rendered regular file becomes AGENTS.md cleanly.
sync_universal_instruction_files() {
  local dir="$1" mode="${2:-}" agents claude gemini
  [ -d "$dir" ] || return 0
  agents="$dir/AGENTS.md"
  claude="$dir/CLAUDE.md"
  gemini="$dir/GEMINI.md"

  if [ "$mode" = "promote-claudemd" ] && [ -f "$claude" ] && [ ! -L "$claude" ]; then
    [ -L "$agents" ] && rm -f "$agents"
    mv -f "$claude" "$agents"
  elif [ ! -f "$agents" ] || [ -L "$agents" ]; then
    if [ -f "$claude" ] && [ ! -L "$claude" ]; then
      [ -L "$agents" ] && rm -f "$agents"
      mv -f "$claude" "$agents"
    elif [ -f "$gemini" ] && [ ! -L "$gemini" ]; then
      [ -L "$agents" ] && rm -f "$agents"
      mv -f "$gemini" "$agents"
    fi
  fi

  if [ -f "$agents" ] && [ ! -L "$agents" ]; then
    if [ ! -e "$claude" ] || [ -L "$claude" ]; then
      ln -sf "AGENTS.md" "$claude"
    fi
    if [ ! -e "$gemini" ] || [ -L "$gemini" ]; then
      ln -sf "AGENTS.md" "$gemini"
    fi
  fi
}
