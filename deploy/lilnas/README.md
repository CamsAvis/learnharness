# LearnHarness on the LilNas dev container

LearnHarness runs in the TrueNAS dev container (192.168.1.2, SSH on host port
5698) as the `learnharness` user, and is reachable only at
**https://learn.itsnotcam.dev**, behind Cloudflare Access (email one-time code,
camallanyoung@gmail.com only).

## How it fits together

| Piece | Where |
|---|---|
| Fork | github.com/CamsAvis/learnharness: `main` mirrors upstream, `deploy` = main + PR #94 + this folder |
| App | systemd user service `learnharness.service`, `node scripts/launch-app.mjs` on **127.0.0.1:3005 only** |
| Tunnel | `learnharness-tunnel.service` (cloudflared, token in `~/.config/cloudflared/learnharness.env`) |
| Cloudflare | tunnel `learnharness`, DNS `learn` CNAME (proxied), Access app `learnharness` + policy `learnharness: allow Cam` |
| Releases | `~/releases/<commit>/`, active one linked at `~/current` (last 3 kept) |
| Data | `~/learnharness-data/` (sessions, settings, API keys, `acp-host.json`); never touched by deploys |

The app has no login of its own. Never bind it to anything but 127.0.0.1 or
open a TrueNAS proxy port to it; Cloudflare Access is the only gate.

## Deploying updates

```powershell
& D:\Software\learnharness\deploy\lilnas\deploy.ps1          # add -Test to run the test suite first
```

It syncs `main` with upstream, merges it into `deploy`, asks before taking new
PR #94 commits, pushes, builds a new release on the container, switches to it
and health-checks it (rolling back if it doesn't answer). Every build also runs
upstream's provider-payload and server-boot checks before it can go live.

`-Test` additionally runs typecheck and the full suite before switching. On this
2-CPU container one upstream test (`chatgpt-auth.test.ts`, "repeated real
verified sign-in…") fails by timing even when rerun alone; it covers desktop
ChatGPT sign-in, which this web setup doesn't use. While that's true, `-Test`
will refuse to switch, so use it to inspect results rather than as a gate.

## Operating it (SSH in as learnharness)

```powershell
ssh -i $HOME\.ssh\id_rsa -p 5698 learnharness@192.168.1.2
```

- Status: `systemctl --user status learnharness learnharness-tunnel`
- Logs: `journalctl --user -u learnharness -f`
- Restart: `systemctl --user restart learnharness`
- Roll back: `ln -sfn ~/releases/<older> ~/current && systemctl --user restart learnharness`

## Claude Code subscription (PR #94)

Claude Code and its ACP adapter are installed for this user under `~/.local`.
Sign-in is yours to do once: `claude auth login`. The app's **Connect** button
only accepts requests made from the container itself (by design, it refuses
them through the tunnel), so connect from an SSH session:

```bash
curl -s -X POST http://127.0.0.1:3005/api/acp/claude -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3005' -d '{}'
```

Reconnect the same way after upgrading the adapter or changing plans.

Current model slots (Settings → Agent → Models): Strong = Claude Code Opus 5.5,
Cheap and Vision = Claude Code Sonnet 5.5. Each session keeps the model it was
started with; change an existing one with the picker under the composer.

Installed and verified 2026-10-25: Claude Code 2.1.310 (native binary, installed
with `--allow-scripts=@anthropic-ai/claude-code`) and claude-agent-acp 0.95.0.
A real lesson turn through Opus 5.5 ran tool calls through the adapter and
paused on the first question as designed.

## One-time setup (already done)

- `bootstrap-root.sh` (as root): user, SSH key, lingering, Chrome, cloudflared.
- `install-node.sh` (as learnharness): Node 26 under `~/.local/opt/node`.
