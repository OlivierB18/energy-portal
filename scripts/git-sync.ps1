param()

$ErrorActionPreference = 'Stop'

function Get-DefaultBranch {
  $ref = git symbolic-ref refs/remotes/origin/HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $ref) {
    return ($ref -replace '^refs/remotes/origin/', '').Trim()
  }

  $mainCheck = git show-ref --verify --quiet refs/heads/main
  if ($LASTEXITCODE -eq 0) { return 'main' }
  return 'master'
}

$defaultBranch = Get-DefaultBranch
Write-Host "[git-sync] Default branch: $defaultBranch"

$isDirty = (git status --porcelain) -ne $null -and (git status --porcelain).Trim().Length -gt 0
if ($isDirty) {
  throw "Working tree is not clean. Commit or stash your changes first, then run git:sync again."
}

git fetch --prune origin
if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

$hasLocalDefault = git show-ref --verify --quiet "refs/heads/$defaultBranch"
if ($LASTEXITCODE -ne 0) {
  git checkout -b $defaultBranch "origin/$defaultBranch"
  if ($LASTEXITCODE -ne 0) { throw "failed to create local branch $defaultBranch from origin/$defaultBranch" }
} else {
  git checkout $defaultBranch
  if ($LASTEXITCODE -ne 0) { throw "git checkout $defaultBranch failed" }
}

git pull --ff-only origin $defaultBranch
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only origin $defaultBranch failed" }

Write-Host '[git-sync] Repo is up to date.'
