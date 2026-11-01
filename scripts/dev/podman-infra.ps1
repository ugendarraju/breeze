# Local dev infrastructure (Postgres + Redis) on Podman, for Windows without Docker.
# Reads POSTGRES_PASSWORD / REDIS_PASSWORD from the repo-root .env.
#
#   .\scripts\dev\podman-infra.ps1 up      # start machine + containers
#   .\scripts\dev\podman-infra.ps1 down    # stop containers (data kept)
#   .\scripts\dev\podman-infra.ps1 status
#   .\scripts\dev\podman-infra.ps1 reset   # remove containers AND data volumes

param([ValidateSet('up', 'down', 'status', 'reset')][string]$Action = 'up')
$ErrorActionPreference = 'Stop'

$envFile = Join-Path $PSScriptRoot '..\..\.env'
$vars = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object {
    $vars[$Matches[1]] = $Matches[2].Trim()
}
$pgPassword = $vars['POSTGRES_PASSWORD']
$redisPassword = $vars['REDIS_PASSWORD']
if (-not $pgPassword -or -not $redisPassword) { throw 'POSTGRES_PASSWORD and REDIS_PASSWORD must be set in .env' }

function Start-PodmanMachine {
    $running = podman machine list --format '{{.Running}}' | Select-String 'true'
    if (-not $running) { podman machine start }
}

function Start-Container($name, [string[]]$runArgs) {
    $exists = podman ps -a --filter "name=^$name$" --format '{{.Names}}'
    if ($exists) { podman start $name | Out-Null } else { podman run -d --name $name @runArgs | Out-Null }
    Write-Host "$name started"
}

switch ($Action) {
    'up' {
        Start-PodmanMachine
        Start-Container 'breeze-postgres' @(
            '-p', '127.0.0.1:5432:5432',
            '-e', 'POSTGRES_USER=breeze', '-e', "POSTGRES_PASSWORD=$pgPassword", '-e', 'POSTGRES_DB=breeze',
            '-v', 'breeze_pg_data:/var/lib/postgresql/data',
            'docker.io/pgvector/pgvector:pg16',
            'postgres', '-c', 'idle_in_transaction_session_timeout=60s'
        )
        Start-Container 'breeze-redis' @(
            '-p', '127.0.0.1:6379:6379',
            '-v', 'breeze_redis_data:/data',
            'docker.io/library/redis:7-alpine',
            'redis-server', '--appendonly', 'yes', '--maxmemory', '256mb',
            '--maxmemory-policy', 'noeviction', '--requirepass', $redisPassword
        )
    }
    'down' { podman stop breeze-postgres breeze-redis }
    'status' { podman ps -a --filter 'name=breeze-' }
    'reset' {
        podman rm -f breeze-postgres breeze-redis
        podman volume rm breeze_pg_data breeze_redis_data
    }
}
