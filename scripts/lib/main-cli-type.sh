#!/bin/bash
# Shared helpers for detecting the configured CLI type (claude|codex|agy) from a
# model ID or install directory, and mirroring ~/.claude/skills/ into Codex and
# Antigravity global skill directories.

marveen_strip_quotes() {
  local v="${1:-}"
  v="$(printf '%s' "$v" | sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s' "$v"
}

marveen_model_cli_type() {
  local m="${1:-}" install_dir="${2:-}" cli=""
  if [ -n "$m" ] && [ -n "$install_dir" ] && [ -f "$install_dir/dist/cli-detector.js" ] && command -v node >/dev/null 2>&1; then
    cli="$(node -e "import(process.argv[1]).then(x=>process.stdout.write(x.getCliTypeForModel(process.argv[2])))" "$install_dir/dist/cli-detector.js" "$m" 2>/dev/null || true)"
  fi
  case "$cli" in
    claude|codex|agy) printf '%s' "$cli"; return 0 ;;
  esac
  case "$(printf '%s' "$m" | tr '[:upper:]' '[:lower:]')" in
    codex:*|openai:*|gpt-*|o1|o1-*|o3|o3-*|o4|o4-*|codex-*) printf 'codex' ;;
    agy:*|antigravity:*|gemini-*|agy-*|*-low|*-medium|*-high|*-xhigh) printf 'agy' ;;
    *) printf 'claude' ;;
  esac
}

marveen_read_main_model() {
  local install_dir="${1:-}" m=""
  if [ -n "$install_dir" ] && [ -f "$install_dir/.env" ]; then
    m="$(grep -E '^MAIN_AGENT_MODEL=' "$install_dir/.env" 2>/dev/null | tail -1 | cut -d= -f2-)"
    m="$(marveen_strip_quotes "$m")"
  fi
  if [ -z "$m" ] && [ -n "$install_dir" ] && [ -f "$install_dir/.claude/settings.json" ]; then
    m="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("model") or "")' "$install_dir/.claude/settings.json" 2>/dev/null || true)"
    m="$(marveen_strip_quotes "$m")"
  fi
  printf '%s' "$m"
}

marveen_main_cli_type() {
  local install_dir="${1:-}" m
  m="$(marveen_read_main_model "$install_dir")"
  marveen_model_cli_type "$m" "$install_dir"
}

sync_universal_skills_dirs() {
  local src_dir="${1:-$HOME/.claude/skills}"
  [ -d "$src_dir" ] || return 0
  local target_root d name
  for target_root in "$HOME/.agents/skills" "$HOME/.gemini/antigravity/skills"; do
    mkdir -p "$target_root" 2>/dev/null || continue
    for d in "$src_dir"/*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      if [ -L "$target_root/$name" ] || [ ! -e "$target_root/$name" ]; then
        ln -sfn "${d%/}" "$target_root/$name" 2>/dev/null || true
      fi
    done
  done
}
