#!/bin/bash
# pi-config setup script
# Usage: ./setup.sh [--dry-run]
# Installs pi-agent configuration into ~/.pi/agent/
#
# Optional environment variables (set in ~/.zshrc or ~/.bashrc):
#   PI_LLAMA_CPP_URL   - URL of your llama-cpp server (e.g. http://192.168.0.XXX:8080/v1)
#   PI_OLLAMA_URL      - URL of your ollama server (e.g. http://192.168.0.XXX:11434/v1)

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

# Escape values used as sed replacement text; URLs may contain &, |, or backslashes.
sed_replacement() {
  printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

AGENT_DIR="$HOME/.pi/agent"

echo "🔧 Setting up pi-agent configuration..."
echo "   Target: $AGENT_DIR"

# Create directory
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$AGENT_DIR"
fi

# Copy config files
for file in settings.json APPEND_SYSTEM.md mcp.json AGENTS.md package.json package-lock.json setup.sh; do
  if [[ -f "$file" ]]; then
    if [[ $DRY_RUN -eq 0 ]]; then
      cp "$file" "$AGENT_DIR/"
      echo "  ✅ $file"
    else
      echo "  📄 $file (would copy)"
    fi
  fi
done

# Generate models.json from template with env var substitution
if [[ -f "models.json.template" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    # Environment variables are optional; unset values become empty strings.
    if [[ -z "${PI_LLAMA_CPP_URL:-}" || -z "${PI_OLLAMA_URL:-}" ]]; then
      echo ""
      echo "⚠️  PI_LLAMA_CPP_URL and/or PI_OLLAMA_URL are not set."
      echo "   Generating models.json with empty URL placeholders."
      echo "   Set them in ~/.zshrc or ~/.bashrc and rerun setup.sh if you need local providers."
    fi

    # Substitute env vars in the template using sed.
    # Single quotes protect the ${VAR} placeholders from shell expansion.
    llama_cpp_url=$(sed_replacement "${PI_LLAMA_CPP_URL:-}")
    ollama_url=$(sed_replacement "${PI_OLLAMA_URL:-}")
    sed -e 's|${PI_LLAMA_CPP_URL}|'"$llama_cpp_url"'|g' \
        -e 's|${PI_OLLAMA_URL}|'"$ollama_url"'|g' \
        "models.json.template" > "$AGENT_DIR/models.json"
    echo "  ✅ models.json (generated from template)"
  else
    echo "  📄 models.json.template (would generate models.json)"
  fi
fi

# Install extension dependencies when a package manifest is present.
if [[ -f "package.json" ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
      echo "❌ Node.js 20+ and npm are required to install Pi extension dependencies." >&2
      exit 1
    fi
    node_major=$(node -p 'process.versions.node.split(".")[0]')
    if (( node_major < 20 )); then
      echo "❌ Node.js 20+ is required; found $(node --version)." >&2
      exit 1
    fi
    npm ci --prefix "$AGENT_DIR" --omit=dev --ignore-scripts --no-audit --no-fund
    echo "  ✅ runtime dependencies"
  else
    echo "  📦 package dependencies (would install with npm ci --ignore-scripts)"
  fi
fi

# Copy directories
for dir in agents skills extensions prompts themes bin; do
  if [[ -d "$dir" ]]; then
    if [[ $DRY_RUN -eq 0 ]]; then
      cp -r "$dir" "$AGENT_DIR/"
      echo "  ✅ $dir/"
    else
      echo "  📁 $dir/ (would copy)"
    fi
  fi
done

echo ""
echo "✅ Done! Restart pi for changes to take effect."
