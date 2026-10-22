# Minimal console logging. To keep a log, redirect all output from your scheduler:
#   powershell.exe -File Sync-ServiceCalls.ps1 *>> sync.log
# PRODUCTION NOTE: rotate the log file, alert on errors, and never log the settings object or
# request headers: they hold secrets.

function Write-Log {
    param(
        [ValidateSet('INFO', 'WARN', 'ERROR')] [string] $Level,
        [string] $Message
    )
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    # Write-Host, not Write-Output, so log lines never mix into a function's return value.
    Write-Host ('{0} {1,-5} {2}' -f $stamp, $Level, $Message)
}
