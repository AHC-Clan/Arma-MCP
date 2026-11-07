# Starts and controls the one long-running Arma-MCP daemon.
#
# The daemon owns the game pipe but never owns the Arma process lifetime:
# stopping it leaves an already running dedicated server alive, and the addon
# reconnects after the daemon starts again.

[CmdletBinding()]
param(
    [ValidateSet('start', 'status', 'stop', 'restart')]
    [string]$Action = 'status',
    [string]$Entry = '',
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Entry) {
    $Entry = Join-Path $root 'server\bundle\index.mjs'
}
$Entry = [System.IO.Path]::GetFullPath($Entry)

function Read-DaemonSettings {
    $configPath = $env:ARMA_MCP_CONFIG
    if (-not $configPath) {
        $configPath = Join-Path $env:USERPROFILE '.arma-mcp\config.json'
        if (-not (Test-Path -LiteralPath $configPath)) {
            $configPath = Join-Path $root 'arma-mcp.config.json'
        }
    }

    $config = $null
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    }

    $port = 5303
    if ($config -and $config.mcp -and $config.mcp.port) {
        $port = [int]$config.mcp.port
    }
    if ($env:ARMA_MCP_DAEMON_PORT) {
        $port = [int]$env:ARMA_MCP_DAEMON_PORT
    }

    $tokenFile = ''
    if ($config -and $config.mcp -and $config.mcp.tokenFile) {
        $tokenFile = [string]$config.mcp.tokenFile
    }
    if ($env:ARMA_MCP_TOKEN_FILE) {
        $tokenFile = $env:ARMA_MCP_TOKEN_FILE
    }
    if (-not $tokenFile) {
        $localAppData = $env:LOCALAPPDATA
        if (-not $localAppData) {
            $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
        }
        $tokenFile = Join-Path $localAppData 'Arma-MCP\daemon.token'
    }

    [pscustomobject]@{
        Port = $port
        BaseUrl = "http://127.0.0.1:$port"
        TokenFile = [System.IO.Path]::GetFullPath($tokenFile)
    }
}

function Read-DaemonToken([object]$Settings) {
    if ($env:ARMA_MCP_TOKEN) {
        return $env:ARMA_MCP_TOKEN.Trim()
    }
    if (-not (Test-Path -LiteralPath $Settings.TokenFile)) {
        throw "Daemon token not found: $($Settings.TokenFile). Start the daemon first or set ARMA_MCP_TOKEN."
    }
    return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Settings.TokenFile).Trim()
}

function Invoke-DaemonRequest([object]$Settings, [string]$Method, [string]$Path) {
    $token = Read-DaemonToken $Settings
    $headers = @{ Authorization = "Bearer $token" }
    Invoke-RestMethod -Method $Method -Uri ($Settings.BaseUrl + $Path) -Headers $headers
}

function Get-DaemonHealth([object]$Settings, [switch]$Quiet) {
    try {
        return Invoke-DaemonRequest $Settings 'GET' '/health'
    } catch {
        if (-not $Quiet) {
            throw
        }
        return $null
    }
}

function Start-Daemon([object]$Settings) {
    if (Get-DaemonHealth $Settings -Quiet) {
        throw "Arma-MCP daemon is already running at $($Settings.BaseUrl)."
    }
    if (-not (Test-Path -LiteralPath $Entry)) {
        throw "Daemon entrypoint not found: $Entry"
    }

    if ($Foreground) {
        & node $Entry daemon
        return
    }

    $stateDir = Split-Path -Parent $Settings.TokenFile
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $stdoutLog = Join-Path $stateDir 'daemon.stdout.log'
    $stderrLog = Join-Path $stateDir 'daemon.log'
    $quotedEntry = '"' + $Entry.Replace('"', '\"') + '"'
    $proc = Start-Process -FilePath 'node' `
        -ArgumentList "$quotedEntry daemon" `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        if ($proc.HasExited) {
            $tail = if (Test-Path -LiteralPath $stderrLog) {
                (Get-Content -Tail 20 -LiteralPath $stderrLog) -join [Environment]::NewLine
            } else {
                ''
            }
            throw "Daemon exited during startup (code $($proc.ExitCode)).`n$tail"
        }
        $health = Get-DaemonHealth $Settings -Quiet
        if ($health) {
            $health
            return
        }
    } while ([DateTime]::UtcNow -lt $deadline)

    throw "Daemon process $($proc.Id) did not become healthy within 15 seconds. See $stderrLog"
}

$settings = Read-DaemonSettings
switch ($Action) {
    'start' {
        Start-Daemon $settings
    }
    'status' {
        $health = Get-DaemonHealth $settings -Quiet
        if (-not $health) {
            Write-Error "Arma-MCP daemon is not reachable at $($settings.BaseUrl)."
            exit 1
        }
        $health
    }
    'stop' {
        Invoke-DaemonRequest $settings 'POST' '/shutdown'
    }
    'restart' {
        $health = Get-DaemonHealth $settings -Quiet
        if ($health) {
            Invoke-DaemonRequest $settings 'POST' '/shutdown' | Out-Null
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                Start-Sleep -Milliseconds 200
                if (-not (Get-DaemonHealth $settings -Quiet)) {
                    break
                }
            } while ([DateTime]::UtcNow -lt $deadline)
        }
        Start-Daemon $settings
    }
}
