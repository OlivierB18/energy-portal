param(
  [Parameter(Mandatory = $true)]
  [string]$Name,
  [string]$WorktreeRoot = '..\\energy-portal.worktrees',
  [switch]$DeleteLocalBranch
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir '..')

Push-Location $repoRoot
try {
  $taskFolder = ($Name -replace '/', '-')
  $resolvedWorktreeRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $WorktreeRoot))
  $worktreePath = Join-Path $resolvedWorktreeRoot $taskFolder
  $branchName = "copilot/$Name"

  if (Test-Path $worktreePath) {
    git worktree remove "$worktreePath"
    if ($LASTEXITCODE -ne 0) {
      throw "git worktree remove failed for $worktreePath"
    }
    Write-Host "[git-worktree-clean] Removed worktree: $worktreePath"
  } else {
    Write-Host "[git-worktree-clean] Worktree not found, skipping: $worktreePath"
  }

  if ($DeleteLocalBranch) {
    git show-ref --verify --quiet "refs/heads/$branchName"
    if ($LASTEXITCODE -eq 0) {
      git branch -D "$branchName"
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to delete local branch $branchName"
      }
      Write-Host "[git-worktree-clean] Deleted local branch: $branchName"
    } else {
      Write-Host "[git-worktree-clean] Local branch not found, skipping: $branchName"
    }
  }

  git fetch --prune origin
  if ($LASTEXITCODE -ne 0) {
    throw 'git fetch --prune origin failed'
  }

  Write-Host '[git-worktree-clean] Done.'
}
finally {
  Pop-Location
}
