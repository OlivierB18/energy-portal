param(
  [Parameter(Mandatory = $true)]
  [string]$Name
)

$ErrorActionPreference = 'Stop'

if ($Name -notmatch '^[a-z0-9._/-]+$') {
  throw 'Use a safe branch name, for example: feature/chart-fix or chore/setup-workflow'
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$scriptDir/git-sync.ps1"

$exists = git show-ref --verify --quiet "refs/heads/$Name"
if ($LASTEXITCODE -eq 0) {
  git checkout $Name
  if ($LASTEXITCODE -ne 0) { throw "git checkout $Name failed" }
  Write-Host "[git-start-feature] Switched to existing branch: $Name"
  exit 0
}

git checkout -b $Name
if ($LASTEXITCODE -ne 0) { throw "git checkout -b $Name failed" }

Write-Host "[git-start-feature] Created and switched to: $Name"
