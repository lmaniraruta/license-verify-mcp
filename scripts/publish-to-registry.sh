#!/bin/bash
# Run AFTER `npm publish` is confirmed live.
# Uses gh CLI auth (already logged in) to register with Anthropic MCP registry.
set -e

echo "Exchanging GitHub token for registry JWT..."
GITHUB_TOKEN=$(gh auth token)
REGISTRY_TOKEN=$(curl -sf -X POST "https://registry.modelcontextprotocol.io/v0.1/auth/github-at" \
  -H "Content-Type: application/json" \
  -d "{\"github_token\": \"$GITHUB_TOKEN\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['registry_token'])")
echo "JWT obtained."

echo "Publishing to Anthropic MCP registry..."
RESULT=$(curl -s -w "\nHTTP:%{http_code}" -X POST "https://registry.modelcontextprotocol.io/v0.1/publish" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $REGISTRY_TOKEN" \
  -d "$(cat server.json)")

echo "$RESULT"

echo ""
echo "Verifying registration..."
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.lmaniraruta%2Flicense-verify-mcp" | python3 -c "import json,sys; d=json.load(sys.stdin); print('name:', d.get('name')); print('version:', d.get('version'))"
