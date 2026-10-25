#!/usr/bin/env bash
# Installs or updates Node.js for the learnharness user, without root.
#
# Downloads the newest release of one major version from nodejs.org, checks
# it against the published SHA-256 list, unpacks it under ~/.local/opt and
# points ~/.local/opt/node at it. npm's global prefix is ~/.local, so global
# tools (Claude Code, the ACP adapter) survive Node upgrades.
#
# Runs over SSH from deploy.ps1, so it does not pause at the end.
#   NODE_MAJOR=26 bash install-node.sh

set -euo pipefail

MAJOR=${NODE_MAJOR:-26}
BASE="https://nodejs.org/dist/latest-v${MAJOR}.x"
OPT="$HOME/.local/opt"
mkdir -p "$OPT" "$HOME/.local/bin"

SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt")
FILE=$(printf '%s\n' "$SUMS" | awk '$2 ~ /-linux-x64\.tar\.xz$/ { print $2; exit }')
if [ -z "$FILE" ]; then
	echo "No linux-x64 build found at $BASE"
	exit 1
fi
DIR="$OPT/${FILE%.tar.xz}"

if [ -x "$DIR/bin/node" ]; then
	echo "Already installed: ${FILE%.tar.xz}"
else
	TMP=$(mktemp -d)
	trap 'rm -rf "$TMP"' EXIT
	curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
	(cd "$TMP" && printf '%s\n' "$SUMS" | grep "  $FILE\$" | sha256sum --check --quiet -)
	tar -xJf "$TMP/$FILE" -C "$OPT"
	echo "Installed: ${FILE%.tar.xz} (checksum verified)"
fi

ln -sfn "$DIR" "$OPT/node"
"$OPT/node/bin/npm" config set prefix "$HOME/.local" >/dev/null
echo "node $("$OPT/node/bin/node" --version), npm $("$OPT/node/bin/npm" --version)"
