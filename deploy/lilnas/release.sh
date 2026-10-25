#!/usr/bin/env bash
# Builds and activates one LearnHarness release in the LilNas dev container.
#
# Runs as the learnharness user. deploy.ps1 copies it over and runs:
#   bash ~/release.sh <commit> [--test]
# It is called from another script, so it does not pause at the end.
#
# Layout under /home/learnharness:
#   repo/                       clone of github.com/CamsAvis/learnharness
#   releases/<commit>/          one built checkout per deployed commit
#   current -> releases/<commit>   what the service runs
#   learnharness-data/          sessions, settings, keys, acp-host.json
#
# The data folder is never touched here. A failed build leaves 'current' and
# the running app alone; a release that fails its health check is rolled back.

set -euo pipefail

COMMIT=${1:?usage: release.sh <commit> [--test]}
RUN_TESTS=${2:-}
REPO_URL=https://github.com/CamsAvis/learnharness.git
PORT=3005
KEEP=3

export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1
export CHROME_PATH=/usr/bin/google-chrome-stable
# The container has 4 GB of RAM; give the production build most of it.
export NODE_OPTIONS=--max-old-space-size=3072

log() { printf '\n== %s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
	echo "Node is missing. Run install-node.sh first."
	exit 1
fi

log "Fetching $COMMIT"
if [ ! -d "$HOME/repo/.git" ]; then
	git clone --quiet --no-checkout "$REPO_URL" "$HOME/repo"
fi
git -C "$HOME/repo" fetch --quiet --prune origin
FULL=$(git -C "$HOME/repo" rev-parse --verify --quiet "$COMMIT^{commit}") || {
	echo "Commit $COMMIT is not on GitHub yet. Push it first."
	exit 1
}
SHORT=${FULL:0:7}
DIR="$HOME/releases/$SHORT"

if [ -f "$DIR/.lh-built" ]; then
	log "Release $SHORT is already built"
else
	# A half-finished earlier attempt has no marker; start it over.
	rm -rf "$DIR"
	git -C "$HOME/repo" worktree prune
	mkdir -p "$HOME/releases"
	git -C "$HOME/repo" worktree add --quiet --detach "$DIR" "$FULL"
	cd "$DIR"

	log "Installing dependencies"
	npm ci --no-audit --no-fund --loglevel=error

	log "Building"
	npm run build -- --webpack
	node scripts/build-server.mjs
	touch "$DIR/.lh-built"
fi

if [ "$RUN_TESTS" = "--test" ]; then
	cd "$DIR"
	log "Typecheck"
	npm run typecheck
	log "Tests"
	if npm test > .lh-test.log 2>&1; then
		grep -aE '^ℹ (tests|pass|fail)' .lh-test.log
	else
		grep -aE '^ℹ (tests|pass|fail)' .lh-test.log
		# A few upstream tests are timing-sensitive and can fail under full-suite
		# load on 2 CPUs. Rerun only the failing files, once, on their own.
		mapfile -t failed < <(grep -aoE '^test at tests/[^:]+' .lh-test.log | sed 's/^test at //' | sort -u)
		if [ "${#failed[@]}" -eq 0 ]; then
			echo "Tests failed; full log: $DIR/.lh-test.log"
			exit 1
		fi
		echo "Rerunning the failing files on their own: ${failed[*]}"
		if NODE_ENV=test node --import tsx --test "${failed[@]}" > .lh-test-retry.log 2>&1; then
			echo "WARNING: they pass on their own, so treating them as flaky. Logs: $DIR/.lh-test.log, $DIR/.lh-test-retry.log"
		else
			grep -aE '^✖' .lh-test-retry.log | head -n 20
			echo "Tests still fail; logs in $DIR. Not switching to this release."
			exit 1
		fi
	fi
fi

log "Installing service units"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
install -m 644 "$DIR/deploy/lilnas/learnharness.service" "$UNITS/"
install -m 644 "$DIR/deploy/lilnas/learnharness-tunnel.service" "$UNITS/"
systemctl --user daemon-reload

PREV=$(readlink -f "$HOME/current" 2>/dev/null || true)
log "Activating $SHORT (previous: ${PREV:+$(basename "$PREV")}${PREV:-none})"
ln -sfn "$DIR" "$HOME/current"
systemctl --user enable --quiet learnharness.service
systemctl --user restart learnharness.service

log "Health check"
code=000
for _ in $(seq 1 45); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/chat/new" || true)
	[ "$code" = 200 ] && break
	sleep 2
done
if [ "$code" != 200 ]; then
	echo "The app did not answer (last HTTP status: $code)."
	journalctl --user -u learnharness.service -n 30 --no-pager 2>/dev/null || true
	if [ -n "$PREV" ] && [ "$PREV" != "$DIR" ]; then
		echo "Rolling back to $(basename "$PREV")."
		ln -sfn "$PREV" "$HOME/current"
		systemctl --user restart learnharness.service
	fi
	exit 1
fi
echo "OK: running $SHORT, http://127.0.0.1:$PORT answers 200"
ss -ltn | awk -v p=":$PORT" '$4 ~ p"$" { print "listening on " $4 }'

log "Pruning old releases (keeping $KEEP)"
ACTIVE=$(readlink -f "$HOME/current")
ls -1dt "$HOME"/releases/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
	old=${old%/}
	[ "$(readlink -f "$old")" = "$ACTIVE" ] && continue
	git -C "$HOME/repo" worktree remove --force "$old" && echo "removed $(basename "$old")"
done
echo "done"
