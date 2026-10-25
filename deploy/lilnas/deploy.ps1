<#
.SYNOPSIS
  Update the fork from upstream (and PR #94), then build and deploy to the
  LilNas dev container.

.DESCRIPTION
  Run from anywhere:  & D:\Software\learnharness\deploy\lilnas\deploy.ps1 [-Test]

  1. Fetches upstream (amosblomqvist/learnharness) and PR #94.
  2. Fast-forwards your fork's main to upstream main and pushes it.
  3. Merges upstream main into deploy. If PR #94 has new commits that are not
     yet upstream, lists them and asks before merging (it's third-party code).
     Once the PR lands upstream, its changes simply arrive through main.
  4. Pushes deploy to your fork, then runs release.sh on the container over
     SSH: build in a new release folder, switch, restart, health check, and
     roll back if the new release doesn't answer.

  On a merge conflict it aborts the merge and stops; the running app is not
  touched. -Test also runs typecheck and the full test suite on the container
  before switching.
#>
param([switch]$Test)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Ssh = @('-o', 'BatchMode=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ServerAliveInterval=30',
         '-i', "$HOME\.ssh\id_rsa", '-p', '5698', 'learnharness@192.168.1.2')
$Pr = 94

function Invoke-Git {
	& git -C $Repo @args
	if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed" }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

try {
	Step 'Checking the local clone'
	if (Invoke-Git status --porcelain) { throw "Uncommitted changes in $Repo. Commit or stash them first." }
	$before = Invoke-Git rev-parse --short deploy

	Step 'Fetching upstream and PR #94'
	Invoke-Git fetch --quiet upstream
	Invoke-Git fetch --quiet upstream "+refs/pull/$Pr/head:refs/remotes/upstream/pr-$Pr"
	Invoke-Git fetch --quiet origin

	Step 'Syncing main with upstream'
	Invoke-Git switch --quiet main
	Invoke-Git merge --quiet --ff-only upstream/main
	Invoke-Git push --quiet origin main
	Write-Host "main is at $(Invoke-Git rev-parse --short main)"
	Invoke-Git switch --quiet deploy

	Step 'Merging upstream main into deploy'
	& git -C $Repo merge-base --is-ancestor upstream/main deploy
	if ($LASTEXITCODE -eq 0) { Write-Host 'deploy already contains upstream main' }
	else {
		& git -C $Repo merge --no-edit upstream/main
		if ($LASTEXITCODE -ne 0) { git -C $Repo merge --abort; throw 'Conflict merging upstream main. Merge aborted; nothing was deployed.' }
	}

	Step "Checking PR #$Pr"
	$prState = ''
	try { $prState = (gh pr view $Pr --repo amosblomqvist/learnharness --json state --jq .state) 2>$null } catch { }
	& git -C $Repo merge-base --is-ancestor "upstream/pr-$Pr" upstream/main
	$inUpstream = ($LASTEXITCODE -eq 0)
	if ($inUpstream -or $prState -eq 'MERGED') {
		Write-Host "PR #$Pr is merged upstream; its changes come in through main."
	} elseif ($prState -eq 'CLOSED') {
		Write-Warning "PR #$Pr was closed without merging. Keeping the version already in deploy."
	} else {
		$new = Invoke-Git log --oneline "deploy..upstream/pr-$Pr"
		if (-not $new) { Write-Host "No new PR #$Pr commits." }
		else {
			Write-Host "New commits on PR #$Pr (third-party code):" -ForegroundColor Yellow
			$new | ForEach-Object { Write-Host "  $_" }
			Write-Host "Review: https://github.com/amosblomqvist/learnharness/pull/$Pr/commits"
			if ((Read-Host 'Merge these into deploy? [y/N]') -match '^[yY]') {
				& git -C $Repo merge --no-edit "upstream/pr-$Pr"
				if ($LASTEXITCODE -ne 0) { git -C $Repo merge --abort; throw "Conflict merging PR #$Pr. Merge aborted; nothing was deployed." }
			} else { Write-Host 'Skipped the PR update.' }
		}
	}

	$sha = Invoke-Git rev-parse deploy
	$after = $sha.Substring(0, 7)
	Step "Pushing deploy ($before -> $after)"
	Invoke-Git push --quiet origin deploy

	Step 'Building and switching on the container'
	$flag = if ($Test) { '--test' } else { '' }
	$remote = "set -e; [ -d ~/repo/.git ] || git clone --quiet --no-checkout https://github.com/CamsAvis/learnharness.git ~/repo; " +
	          "git -C ~/repo fetch --quiet origin; git -C ~/repo show ${sha}:deploy/lilnas/release.sh > ~/release.sh; bash ~/release.sh $sha $flag"
	& ssh @Ssh $remote
	if ($LASTEXITCODE -ne 0) { throw 'The container build or health check failed (see above). The previous release is still running.' }

	Step 'Done'
	Write-Host "deploy: $before -> $after"
	Write-Host 'Live at https://learn.itsnotcam.dev' -ForegroundColor Green
}
catch {
	Write-Host "`nERROR: $_" -ForegroundColor Red
	git -C $Repo switch --quiet deploy 2>$null
}
finally {
	Read-Host "`nPress Enter to close"
}
