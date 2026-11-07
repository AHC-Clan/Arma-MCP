# publish-github.ps1 - publishes the committed tree to the public GitHub repository.
#
# The public repository has its own history. It never receives this repository's
# private commits: each run adds one commit that holds HEAD's tree on top of
# github/main, without the paths below. Session-start self-update reads the
# marketplace version, so a publish that does not raise the version would reach no
# user and is refused.
#
# Usage:
#   powershell build\publish-github.ps1 -Message "Release 0.5.11"
#   powershell build\publish-github.ps1 -DryRun     # run the checks, push nothing
#
# Authentication goes through the gh CLI for this one command, so the machine's git
# credential settings stay as they are.

[CmdletBinding()]
param(
    [string]$Message,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$publicUrl = 'https://github.com/AHC-Clan/Arma-MCP.git'
$auth = @(
    '-c', 'credential.https://github.com.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth git-credential'
)

# Maintainer files stay out of the public tree: this folder, and any path listed in it.
$internalDir = 'docs/internal'
$privatePaths = @($internalDir)
$excludeFile = "$internalDir/public-exclude.txt"
if (Test-Path $excludeFile) { $privatePaths += @(Get-Content $excludeFile | Where-Object { $_.Trim() }) }
# Optional, and private itself: one extended regex per line.
$denyFile = "$internalDir/public-denylist.txt"

function Invoke-Git {
    $out = & git @args
    if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed (exit $LASTEXITCODE)" }
    return $out
}

if (Invoke-Git status --porcelain) {
    throw 'The working tree has uncommitted changes. Only committed files can be published.'
}

# Build the public tree in a throwaway index, so the real index and files stay as they are.
$indexFile = [System.IO.Path]::GetTempFileName()
Remove-Item $indexFile -Force
$env:GIT_INDEX_FILE = $indexFile
try {
    Invoke-Git read-tree HEAD | Out-Null
    Invoke-Git rm -r -q --cached --ignore-unmatch -- @privatePaths | Out-Null
    $tree = Invoke-Git write-tree | Select-Object -First 1
} finally {
    Remove-Item Env:GIT_INDEX_FILE
    Remove-Item $indexFile -Force -ErrorAction SilentlyContinue
}

# The private host must not reach the public tree. Its name comes from the origin
# remote so that this public script does not have to spell it.
$originUrl = & git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $originUrl -and $originUrl -notmatch 'github\.com') {
    $privateHost = ([uri]$originUrl).Host
    $hits = & git grep -I -l -F $privateHost $tree
    if ($LASTEXITCODE -eq 0) {
        throw "The public tree still names the private host in:`n$($hits -join "`n")"
    }
}

if (Test-Path $denyFile) {
    # Rewritten with LF: a checkout can give the list CRLF, and git grep would then look
    # for each word followed by CR and quietly find nothing.
    $patterns = [System.IO.File]::ReadAllLines((Join-Path $root $denyFile), [System.Text.Encoding]::UTF8) |
        ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $patternFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($patternFile, ($patterns -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
        $hits = & git grep -I -n -E -f $patternFile $tree
        $grepExit = $LASTEXITCODE
    } finally {
        Remove-Item $patternFile -Force -ErrorAction SilentlyContinue
    }
    if ($grepExit -eq 0) {
        throw "The public tree still holds private words:`n$(($hits | Select-Object -First 40) -join "`n")"
    }
    if ($grepExit -ne 1) { throw "git grep failed (exit $grepExit)." }
}

$remotes = Invoke-Git remote
if ($remotes -notcontains 'github') { Invoke-Git remote add github $publicUrl | Out-Null }

$version = (Get-Content '.claude-plugin\marketplace.json' -Raw | ConvertFrom-Json).plugins[0].version
$parent = $null
$remoteHead = & git @auth ls-remote --heads github main
if ($LASTEXITCODE -ne 0) { throw "Cannot read $publicUrl. Create the repository or run gh auth login." }
if ($remoteHead) {
    & git @auth fetch github main
    if ($LASTEXITCODE -ne 0) { throw 'git fetch github main failed.' }
    $parent = (Invoke-Git rev-parse FETCH_HEAD | Select-Object -First 1)
    $published = (& git show "${parent}:.claude-plugin/marketplace.json") -join "`n" | ConvertFrom-Json
    if ($published.plugins[0].version -eq $version) {
        throw "Version $version is already published. A release must raise the version."
    }
}

if (-not $Message) { $Message = "Release $version" }
Write-Host "Version: $version"
Write-Host "Tree:    $tree"
Write-Host "Parent:  $(if ($parent) { $parent } else { '(first commit)' })"
if ($DryRun) {
    Write-Host 'Dry run: nothing pushed.'
    exit 0
}

$treeArgs = @($tree)
if ($parent) { $treeArgs += @('-p', $parent) }
# Through a file: piping to a native command in Windows PowerShell adds CR to the message.
$messageFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($messageFile, ($Message -replace "`r`n", "`n").TrimEnd() + "`n", [System.Text.UTF8Encoding]::new($false))
    $commit = (& git commit-tree @treeArgs -F $messageFile) | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $commit) { throw 'git commit-tree failed.' }
} finally {
    Remove-Item $messageFile -Force -ErrorAction SilentlyContinue
}

& git @auth push github "${commit}:refs/heads/main"
if ($LASTEXITCODE -ne 0) { throw 'git push failed.' }
Write-Host "Published $commit to $publicUrl"
