# PowerShell script to kill processes using development ports
# Usage: powershell -ExecutionPolicy Bypass .\kill-ports.ps1

Write-Host "Checking for processes using development ports..." -ForegroundColor Yellow

$ports = @(5000, 5001, 5555, 5173, 4173, 24678)

foreach ($port in $ports) {
    Write-Host "`nChecking port $port..." -ForegroundColor Cyan
    
    $connections = netstat -ano | Select-String ":$port\s"
    
    if ($connections) {
        $pids = @()
        foreach ($conn in $connections) {
            if ($conn -match "LISTENING\s+(\d+)") {
                $pid = $matches[1]
                if ($pids -notcontains $pid) {
                    $pids += $pid
                }
            }
        }
        
        if ($pids) {
            foreach ($pid in $pids) {
                try {
                    $process = Get-Process -Id $pid -ErrorAction Stop
                    Write-Host "Found process: $($process.ProcessName) (PID: $pid) using port $port" -ForegroundColor Red
                    
                    $confirmation = Read-Host "Kill process $($process.ProcessName) (PID: $pid)? [y/N]"
                    if ($confirmation -eq 'y' -or $confirmation -eq 'Y') {
                        Stop-Process -Id $pid -Force
                        Write-Host "Process $pid terminated." -ForegroundColor Green
                    }
                } catch {
                    Write-Host "Process $pid not found or already terminated." -ForegroundColor Gray
                }
            }
        }
    } else {
        Write-Host "Port $port is free." -ForegroundColor Green
    }
}

Write-Host "`nDone checking ports." -ForegroundColor Yellow
