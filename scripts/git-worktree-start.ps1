param(
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$BaseBranch = 'master',
  [string]$WorktreeRoot = '..\\energy-portal.worktrees'
)

$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[a-z0-9._/-]+$') {
  throw 'Use a safe task name, for example: fix/chart-alignment or feat/new-dashboard-card'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')

Push-Location $repoRoot
try {
  $isDirty = (git status --porcelain) -ne $null -and (git status --porcelain).Trim().Length -gt 0
  if ($isDirty) {
    throw 'Working tree is not clean. Commit, stash, or discard changes first.'
  }

  git fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

  git show-ref --verify --quiet "refs/remotes/origin/$BaseBranch"
  if ($LASTEXITCODE -ne 0) {
    throw "Remote base branch origin/$BaseBranch not found"
  }

  git checkout $BaseBranch
  if ($LASTEXITCODE -ne 0) { throw "git checkout $BaseBranch failed" }

  git pull --ff-only origin $BaseBranch
  if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only origin $BaseBranch failed" }

  $branchName = "copilot/$Name"
  git show-ref --verify --quiet "refs/heads/$branchName"
  if ($LASTEXITCODE -eq 0) {
    throw "Local branch already exists: $branchName"
  }

  $resolvedWorktreeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $WorktreeRoot))
  New-Item -ItemType Directory -Force -Path $resolvedWorktreeRoot | Out-Null

  $taskFolder = ($Name -replace '/', '-')
  $worktreePath = Join-Path $resolvedWorktreeRoot $taskFolder

  if (Test-Path $worktreePath) {
    throw "Worktree path already exists: $worktreePath"
  }

  git worktree add "$worktreePath" -b "$branchName" $BaseBranch
  if ($LASTEXITCODE -ne 0) { throw 'git worktree add failed' }

  Write-Host "[git-worktree-start] Created branch: $branchName"
  Write-Host "[git-worktree-start] Worktree path: $worktreePath"
  Write-Host "[git-worktree-start] Open with: code -n \"$worktreePath\""
}
finally {
  Pop-Location
}
