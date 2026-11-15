#!/usr/bin/env bash
# install-headroom.sh — Idempotent Headroom CLI/MCP installer for Marveen.
# Installs headroom-ai via uv (preferred) or an isolated Python >= 3.10 venv
# at ~/.local/share/marveen-headroom-venv with a symlink into ~/.local/bin/headroom.
# Opt out cleanly with MARVEEN_HEADROOM=0. Never aborts host setup if offline.

set -u

if [ "${MARVEEN_HEADROOM:-1}" = "0" ]; then
  echo "  Headroom telepites kihagyva (MARVEEN_HEADROOM=0)."
  exit 0
fi

UPGRADE=0
for arg in "$@"; do
  case "$arg" in
    --upgrade|-U) UPGRADE=1 ;;
  esac
done

LOCAL_BIN="$HOME/.local/bin"
VENV_DIR="${MARVEEN_HEADROOM_VENV:-$HOME/.local/share/marveen-headroom-venv}"
TARGET_BIN="$LOCAL_BIN/headroom"

_headroom_present() {
  if [ -n "${HEADROOM_BIN:-}" ] && [ -x "${HEADROOM_BIN}" ]; then
    return 0
  fi
  if [ -x "$TARGET_BIN" ] || [ -x "$VENV_DIR/bin/headroom" ]; then
    return 0
  fi
  command -v headroom >/dev/null 2>&1
}

if [ "$UPGRADE" -eq 0 ] && _headroom_present; then
  echo "  Headroom mar telepitve van."
  exit 0
fi

_find_uv() {
  if command -v uv >/dev/null 2>&1; then
    command -v uv
    return 0
  fi
  for p in "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "/opt/homebrew/bin/uv" "/usr/local/bin/uv"; do
    if [ -x "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

_find_python310() {
  for p in "${PYTHON3_BIN:-}" "$(command -v python3 2>/dev/null || true)" /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [ -n "$p" ] && [ -x "$p" ] || continue
    if "$p" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$p"
      return 0
    fi
  done
  return 1
}

UV_BIN="$(_find_uv || true)"
if [ -n "$UV_BIN" ]; then
  UV_ARGS=(tool install)
  if [ "$UPGRADE" -eq 1 ]; then
    UV_ARGS+=(--upgrade)
  fi
  if "$UV_BIN" "${UV_ARGS[@]}" "headroom-ai[all]" >/dev/null 2>&1 \
     || "$UV_BIN" "${UV_ARGS[@]}" "headroom-ai[proxy,mcp]" >/dev/null 2>&1; then
    echo "  ✓ Headroom telepitve (uv)"
    exit 0
  fi
  echo "  FIGYELEM: uv tool install sikertelen; Python venv tartalek kovetkezik..." >&2
fi

PY_BIN="$(_find_python310 || true)"
if [ -z "$PY_BIN" ]; then
  echo "  FIGYELEM: Headroom telepites kihagyva (Python >= 3.10 vagy uv nem elerheto)." >&2
  exit 0
fi

if ! mkdir -p "$LOCAL_BIN" "$(dirname "$VENV_DIR")" 2>/dev/null; then
  echo "  FIGYELEM: nem sikerult konyvtarat letrehozni a Headroom szamara." >&2
  exit 0
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
  if ! "$PY_BIN" -m venv "$VENV_DIR" >/dev/null 2>&1; then
    echo "  FIGYELEM: Python venv letrehozasa sikertelen a Headroom szamara." >&2
    exit 0
  fi
fi

PIP_BIN="$VENV_DIR/bin/pip"
if [ ! -x "$PIP_BIN" ]; then
  echo "  FIGYELEM: pip nem elerheto a Headroom venv-ben." >&2
  exit 0
fi

if ! "$PIP_BIN" install --quiet --upgrade "headroom-ai[all]" >/dev/null 2>&1 \
   && ! "$PIP_BIN" install --quiet --upgrade "headroom-ai[proxy,mcp]" >/dev/null 2>&1; then
  echo "  FIGYELEM: Headroom pip telepites sikertelen (offline gep vagy csomag-hiba)." >&2
  exit 0
fi

if [ -x "$VENV_DIR/bin/headroom" ]; then
  if [ ! -L "$TARGET_BIN" ] && [ -e "$TARGET_BIN" ]; then
    echo "  FIGYELEM: $TARGET_BIN mar letezik es nem szimlink; kihagyva." >&2
    exit 0
  fi
  ln -sf "$VENV_DIR/bin/headroom" "$TARGET_BIN"
  echo "  ✓ Headroom telepitve ($TARGET_BIN)"
fi

exit 0
