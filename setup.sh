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

AGENT_DIR="$HOME/.pi/agent"

echo "🔧 Setting up pi-agent configuration..."
echo "   Target: $AGENT_DIR"

# Create directory
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$AGENT_DIR"
fi

# Copy config files
for file in settings.json mcp.json AGENTS.md setup.sh; do
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

    # Substitute env vars in the template using sed
    # Single quotes protect the ${VAR} placeholders from shell expansion
    sed -e 's|${PI_LLAMA_CPP_URL}|'"${PI_LLAMA_CPP_URL:-}"'|g' \
        -e 's|${PI_OLLAMA_URL}|'"${PI_OLLAMA_URL:-}"'|g' \
        "models.json.template" > "$AGENT_DIR/models.json"
    echo "  ✅ models.json (generated from template)"
  else
    echo "  📄 models.json.template (would generate models.json)"
  fi
fi

# Copy directories
for dir in agents skills extensions prompts bin; do
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
