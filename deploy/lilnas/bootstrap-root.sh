#!/usr/bin/env bash
# One-time root setup for running LearnHarness in the LilNas dev container.
#
# Run it once from an SSH session as your normal user, passing the public key
# that should be allowed to log in as the service user:
#
#   sudo bash ~/learnharness-bootstrap.sh ~/learnharness-key.pub
#
# What it does (safe to re-run; each step is skipped when already done):
#   1. Creates the 'learnharness' user: SSH key login only, no password, no sudo.
#   2. Authorizes the given public key for that user.
#   3. Enables lingering, so the user's systemd services run while nobody is
#      logged in.
#   4. Installs cloudflared (the tunnel) from Cloudflare's signed apt repo and
#      Google Chrome (demo and figure rendering) from Google's package, which
#      also registers Google's signed apt repo for updates.
#
# Everything else (Node, the app, Claude Code) installs later as the
# learnharness user, without root.

set -euo pipefail

finish() {
	local status=$?
	echo
	if [ "$status" -eq 0 ]; then
		echo "Bootstrap finished."
	else
		echo "Bootstrap FAILED (exit $status). Steps after the failing one did not run."
	fi
	read -rp "Press Enter to close" _ || true
}
trap finish EXIT

LH_USER=learnharness
KEY_FILE=${1:-}

if [ "$(id -u)" -ne 0 ]; then
	echo "Run this with sudo."
	exit 1
fi
if [ -z "$KEY_FILE" ] || [ ! -s "$KEY_FILE" ]; then
	echo "Pass the public key file as the first argument."
	exit 1
fi
PUBKEY=$(head -n 1 "$KEY_FILE")
case "$PUBKEY" in
	ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*) ;;
	*) echo "$KEY_FILE does not look like an SSH public key."; exit 1 ;;
esac

echo "== 1. User '$LH_USER'"
if id "$LH_USER" >/dev/null 2>&1; then
	echo "already exists"
else
	# useradd leaves the password locked, so only key login works.
	useradd --create-home --shell /bin/bash "$LH_USER"
	echo "created"
fi
LH_HOME=$(getent passwd "$LH_USER" | cut -d: -f6)

echo "== 2. SSH key"
install -d -m 700 -o "$LH_USER" -g "$LH_USER" "$LH_HOME/.ssh"
AUTH="$LH_HOME/.ssh/authorized_keys"
touch "$AUTH"
if grep -qxF "$PUBKEY" "$AUTH"; then
	echo "already authorized"
else
	echo "$PUBKEY" >> "$AUTH"
	echo "authorized: $(echo "$PUBKEY" | cut -d' ' -f1,3)"
fi
chown "$LH_USER:$LH_USER" "$AUTH"
chmod 600 "$AUTH"

echo "== 3. Lingering (services run without a login)"
loginctl enable-linger "$LH_USER"
echo "linger: $(loginctl show-user "$LH_USER" -p Linger --value 2>/dev/null || echo unknown)"

echo "== 4. Packages"
apt-get update -q
apt-get install -y -q --no-install-recommends ca-certificates curl xz-utils

if command -v cloudflared >/dev/null 2>&1; then
	echo "cloudflared already installed: $(cloudflared --version 2>&1 | head -n 1)"
else
	install -d -m 0755 /usr/share/keyrings
	curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
	echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
		> /etc/apt/sources.list.d/cloudflared.list
	apt-get update -q
	apt-get install -y -q cloudflared
	echo "cloudflared installed: $(cloudflared --version 2>&1 | head -n 1)"
fi

if command -v google-chrome-stable >/dev/null 2>&1; then
	echo "Chrome already installed: $(google-chrome-stable --version)"
else
	CHROME_DEB=$(mktemp --suffix=.deb)
	curl -fsSL -o "$CHROME_DEB" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
	chmod 644 "$CHROME_DEB"
	apt-get install -y -q "$CHROME_DEB"
	rm -f "$CHROME_DEB"
	echo "Chrome installed: $(google-chrome-stable --version)"
fi
