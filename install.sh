#!/bin/sh
# Install jev for your coding agents, and everything it uses, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/maxkimambo/jev-mcp/main/install.sh | sh
#
# It sets up every agent it finds on PATH: Claude Code, Codex and pi. Name agents to
# pick them instead: `... | sh -s -- codex pi`. Safe to re-run: it updates what is
# installed and skips what is done. JEV_SOURCE overrides where jev comes from: a
# GitHub owner/repo, a git URL, or a local checkout.
set -eu

SOURCE="${JEV_SOURCE:-maxkimambo/jev-mcp}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/jev"
KEY="$CONFIG/api_key"
# The on/off switch and call ledger, shared by every agent.
STATE="${JEV_HOME:-$HOME/.claude/jev-think}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

AGENTS="$*"
if [ -z "$AGENTS" ]; then
  for agent in claude codex pi; do have "$agent" && AGENTS="$AGENTS $agent"; done
fi
[ -n "$AGENTS" ] || die "Found none of claude, codex or pi on PATH. Install one first, or name it: sh -s -- codex"

have node || die "Node.js 20.12 or newer is required: https://nodejs.org"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' ||
  die "Node.js 20.12 or newer is required; found $(node --version)."

LOCAL=""
if [ -d "$SOURCE" ]; then LOCAL=$(cd "$SOURCE" && pwd); fi
case "$SOURCE" in
  *://* | git@*) REPO="$SOURCE" ;;
  *) REPO="https://github.com/$SOURCE.git" ;;
esac

# Claude Code: a plugin with the server, hooks, /jev:jev command and skill.
install_claude() {
  if claude plugin marketplace list 2>/dev/null | grep -q '❯ jev-mcp$'; then
    say "Claude Code: updating the jev-mcp marketplace"
    claude plugin marketplace update jev-mcp
  else
    say "Claude Code: adding the jev-mcp marketplace from $SOURCE"
    claude plugin marketplace add "$SOURCE"
  fi
  if claude plugin list 2>/dev/null | grep -q '❯ jev@jev-mcp$'; then
    claude plugin update jev@jev-mcp
  else
    claude plugin install --scope user jev@jev-mcp
  fi
}

# Codex: the server in config.toml and the skill, from a checkout this script keeps.
install_codex() {
  dir="$LOCAL"
  if [ -z "$dir" ]; then
    have git || die "Codex needs git to fetch jev."
    dir="${XDG_DATA_HOME:-$HOME/.local/share}/jev-mcp"
    if [ -d "$dir/.git" ]; then
      say "Codex: updating $dir"
      git -C "$dir" pull --ff-only --quiet
    else
      say "Codex: fetching jev into $dir"
      git clone --quiet --depth 1 "$REPO" "$dir"
    fi
  fi
  home="${CODEX_HOME:-$HOME/.codex}"
  mkdir -p "$home/skills"
  if grep -q '^\[mcp_servers\.jev\]' "$home/config.toml" 2>/dev/null; then
    say "Codex: the jev server is already in $home/config.toml"
  else
    say "Codex: adding the jev server to $home/config.toml"
    cat >>"$home/config.toml" <<EOF

[mcp_servers.jev]
command = "node"
args = ["$dir/bundle/index.js"]
tool_timeout_sec = 120
env = { JEV_SWITCH_FILE = "$STATE/state.json", JEV_LEDGER = "$STATE/ledger.jsonl" }
EOF
  fi
  ln -sfn "$dir/skills/jev-tools" "$home/skills/jev-tools"
  # Codex has no /jev command, so the switch is a terminal command.
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexec node "%s/bundle/cli.js" "$@"\n' "$dir" >"$HOME/.local/bin/jev"
  chmod +x "$HOME/.local/bin/jev"
}

# pi: a pi package with a native extension (tools and /jev) and the skill.
install_pi() {
  case "$SOURCE" in
    *://* | git@*) src="$SOURCE" ;;
    *) src="${LOCAL:-git:github.com/$SOURCE}" ;;
  esac
  if pi list 2>/dev/null | grep -qF "$src"; then
    say "pi: updating the jev package"
    pi update "$src"
  else
    say "pi: installing the jev package"
    pi install "$src"
  fi
}

for agent in $AGENTS; do
  case "$agent" in
    claude) have claude || die "Claude Code is not installed: https://claude.com/claude-code"; install_claude ;;
    codex) install_codex ;;
    pi) have pi || die "pi is not installed: https://pi.dev"; install_pi ;;
    *) die "Unknown agent '$agent'; choose from claude, codex, pi." ;;
  esac
done

# uv installs the command-line tools below without touching the system Python.
if ! have uv; then
  say "Installing uv (https://docs.astral.sh/uv)"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  PATH="$HOME/.local/bin:$PATH"
fi
tool() {
  if have "$1"; then say "$1 is installed"; else say "Installing $1"; uv tool install "$2" || warn "$1 could not be installed; $3"; fi
}
if ! have rg && have brew; then say "Installing ripgrep"; brew install ripgrep; fi
tool rg ripgrep "jev_search needs it: https://github.com/BurntSushi/ripgrep#installation"
tool trafilatura trafilatura "jev_rank_pages falls back to plain text for HTML pages."
tool markitdown 'markitdown[pdf,docx,pptx,xlsx]' "jev_rank_pages cannot read PDF and Office pages."
case ":$PATH:" in *":$(uv tool dir --bin):"*) ;; *) uv tool update-shell 2>/dev/null || true ;; esac

# The key lives in a file only you can read, never in settings or the environment.
mkdir -p "$CONFIG" && chmod 700 "$CONFIG"
if [ -s "$KEY" ]; then
  chmod 600 "$KEY"
  say "Key file present: $KEY"
elif (: </dev/tty) 2>/dev/null; then
  printf 'Paste your TypeSafe or OpenRouter API key (hidden; Enter to skip): ' >/dev/tty
  trap 'stty echo </dev/tty 2>/dev/null' EXIT INT TERM
  stty -echo </dev/tty
  IFS= read -r key </dev/tty || key=
  stty echo </dev/tty
  printf '\n' >/dev/tty
  key=$(printf '%s' "$key" | tr -d '[:space:]')
  if [ -n "$key" ]; then
    (umask 077 && printf '%s' "$key" >"$KEY")
    say "Saved the key to $KEY (mode 0600)"
  else
    warn "No key saved. Put one in $KEY later, readable only by you (chmod 600)."
  fi
else
  warn "No key yet. Put your TypeSafe or OpenRouter key in $KEY, readable only by you (chmod 600)."
fi

say "Done. Restart your agents, then switch jev on in any one of them; the switch is shared:"
for agent in $AGENTS; do
  case "$agent" in
    claude) echo "    Claude Code: /jev:jev on" ;;
    codex) echo "    Codex:       jev on   (in a terminal)" ;;
    pi) echo "    pi:          /jev on" ;;
  esac
done
