#!/bin/sh
# Install the jev Claude Code plugin and everything it uses, in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/maxkimambo/jev-mcp/main/install.sh | sh
#
# Safe to re-run: it updates what is installed and skips what is done.
# JEV_SOURCE overrides where the plugin comes from (a GitHub repo, git URL or local path).
set -eu

SOURCE="${JEV_SOURCE:-maxkimambo/jev-mcp}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/jev"
KEY="$CONFIG/api_key"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have claude || die "Claude Code is not installed: https://claude.com/claude-code"
have node || die "Node.js 20.12 or newer is required: https://nodejs.org"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' ||
  die "Node.js 20.12 or newer is required; found $(node --version)."

# The plugin: MCP server, hooks, /jev:jev command and skill.
if claude plugin marketplace list 2>/dev/null | grep -q '❯ jev-mcp$'; then
  say "Updating the jev-mcp marketplace"
  claude plugin marketplace update jev-mcp
else
  say "Adding the jev-mcp marketplace from $SOURCE"
  claude plugin marketplace add "$SOURCE"
fi
if claude plugin list 2>/dev/null | grep -q '❯ jev@jev-mcp$'; then
  say "Updating the jev plugin"
  claude plugin update jev@jev-mcp
else
  say "Installing the jev plugin"
  claude plugin install --scope user jev@jev-mcp
fi

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
case ":$PATH:" in *":$(uv tool dir --bin):"*) ;; *) uv tool update-shell || true ;; esac

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

say "Done. Restart Claude Code, then run /jev:jev on"
