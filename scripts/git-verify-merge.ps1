param(
  [string]$Branch,
  [string]$Commit
)

$ErrorActionPreference = 'Stop'

function Get-DefaultBranch {
  git show-ref --verify --quiet refs/remotes/origin/master
  if ($LASTEXITCODE -eq 0) {
    return 'master'
  }

  $ref = git symbolic-ref refs/remotes/origin/HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $ref) {
    return ($ref -replace '^refs/remotes/origin/', '').Trim()
  }

  $mainCheck = git show-ref --verify --quiet refs/heads/main
  if ($LASTEXITCODE -eq 0) { return 'main' }
  return 'master'
}

if (-not $Branch -and -not $Commit) {
  throw "Provide either -Branch <remote-branch> or -Commit <sha>. Example: npm run git:verify-merge -- -Branch copilot/fix-empty-electricity-usage-chart"
}

git fetch --prune origin
if ($LASTEXITCODE -ne 0) { throw 'git fetch --prune origin failed' }

$defaultBranch = Get-DefaultBranch
$targetRef = "origin/$defaultBranch"

if ($Branch) {
  $branchRef = "refs/remotes/origin/$Branch"
  git show-ref --verify --quiet $branchRef
  if ($LASTEXITCODE -ne 0) {
    throw "Remote branch origin/$Branch not found. If the branch was deleted after merge, verify by commit SHA with -Commit."
  }

  git merge-base --is-ancestor "origin/$Branch" $targetRef
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[git-verify-merge] OK: origin/$Branch is contained in $targetRef"
  } else {
    throw "origin/$Branch is NOT contained in $targetRef yet. PR may not be merged into $defaultBranch."
  }
}

if ($Commit) {
  git cat-file -e "$Commit^{commit}" 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Commit $Commit was not found in this repository."
  }

  git merge-base --is-ancestor $Commit $targetRef
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[git-verify-merge] OK: commit $Commit is contained in $targetRef"
  } else {
    throw "Commit $Commit is NOT contained in $targetRef yet. PR may not be merged into $defaultBranch."
  }
}
