#!/bin/bash
# pi-config setup script
# Usage: ./setup.sh [--dry-run]
# Installs pi-agent configuration into ~/.pi/agent/
#
# Required environment variables (set in ~/.zshrc or ~/.bashrc):
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
    # Check required env vars
    MISSING=()
    if [[ -z "${PI_LLAMA_CPP_URL:-}" ]]; then
      MISSING+=("PI_LLAMA_CPP_URL")
    fi
    if [[ -z "${PI_OLLAMA_URL:-}" ]]; then
      MISSING+=("PI_OLLAMA_URL")
    fi

    if [[ ${#MISSING[@]} -gt 0 ]]; then
      echo ""
      echo "⚠️  Missing environment variables: ${MISSING[*]}"
      echo "   Add these to ~/.zshrc or ~/.bashrc:"
      for var in "${MISSING[@]}"; do
        echo "   export $var='your-value-here'"
      done
      echo "   Then run: source ~/.zshrc"
      exit 1
    fi

    # Substitute env vars in the template using sed
    # Single quotes protect the ${VAR} placeholders from shell expansion
    sed -e 's|${PI_LLAMA_CPP_URL}|'"$PI_LLAMA_CPP_URL"'|g' \
        -e 's|${PI_OLLAMA_URL}|'"$PI_OLLAMA_URL"'|g' \
        "models.json.template" > "$AGENT_DIR/models.json"
    echo "  ✅ models.json (generated from template)"
  else
    echo "  📄 models.json.template (would generate models.json)"
  fi
fi

# Copy directories
for dir in agents skills; do
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
