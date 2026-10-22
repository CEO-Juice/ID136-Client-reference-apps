# Everything the script remembers between runs, kept in a JSON file (no database needed).
#
# {
#   "LastCallUpdateSeen": "2026-10-21T11:06:00",   # newest e-automate lastUpdate seen
#   "Links": [ { CallId, CallNumber, IncidentSysId, IncidentNumber, Direction, Completed, CreatedAt } ]
# }
#
# Same format as the .NET and Node versions, so any of them can pick up the others' file.
#
# PRODUCTION NOTE: a local JSON file is the simplest possible store, with real limits:
#   - It lives on one machine. Lose it (new server, restore, cleanup) and the next run treats every
#     open call as new and creates duplicate incidents. Back it up, or keep the links in a database.
#   - There is no locking, so two overlapping runs can overwrite each other's changes.
#   - It never shrinks; completed links are kept forever. Prune old completed links if it gets large.
# A small database table with a unique key on CallId and on IncidentSysId solves all three.

function Read-SyncState {
    param([string] $Path)

    $state = [pscustomobject]@{ LastCallUpdateSeen = $null; Links = @() }
    if (Test-Path $Path) {
        $data = Get-Content -Raw -Path $Path | ConvertFrom-Json
        if ($data.LastCallUpdateSeen) {
            $state.LastCallUpdateSeen = ConvertTo-EautoTime $data.LastCallUpdateSeen
        }
        if ($data.Links) {
            $state.Links = @($data.Links)
        }
    }
    return $state
}

# Write to a temp file first, then replace, so a crash never leaves a half-written file.
# UTF-8 without a byte-order mark, so the .NET and Node versions can read it too.
function Save-SyncState {
    param($State, [string] $Path)

    $json = [ordered]@{
        LastCallUpdateSeen = $State.LastCallUpdateSeen
        Links              = @($State.Links)
    } | ConvertTo-Json -Depth 5

    $tempPath = "$Path.tmp"
    [System.IO.File]::WriteAllText($tempPath, $json, (New-Object System.Text.UTF8Encoding $false))
    if (Test-Path $Path) {
        [System.IO.File]::Replace($tempPath, $Path, $null)
    }
    else {
        [System.IO.File]::Move($tempPath, $Path)
    }
}

function Find-LinkByCall {
    param($State, $CallId)
    return $State.Links | Where-Object { $_.CallId -eq $CallId } | Select-Object -First 1
}

function Find-LinkByIncident {
    param($State, [string] $SysId)
    return $State.Links | Where-Object { $_.IncidentSysId -eq $SysId } | Select-Object -First 1
}

# e-automate times have no time zone ("2026-10-21T11:06:00"). Keep them as text in that fixed
# format so the time zone of the machine running this never shifts them. (PowerShell 7 turns
# such JSON strings into DateTime values; this turns them back without changing the clock time.)
function ConvertTo-EautoTime {
    param($Value)
    if ($Value -is [datetime]) {
        return $Value.ToString('yyyy-MM-ddTHH:mm:ss', [cultureinfo]::InvariantCulture)
    }
    $text = [string] $Value
    if ($text.Length -gt 19) { $text = $text.Substring(0, 19) }
    return $text
}

function Get-EautoTimeMinusMinutes {
    param([string] $EautoTime, [int] $Minutes)
    $time = [datetime]::ParseExact($EautoTime, 'yyyy-MM-ddTHH:mm:ss', [cultureinfo]::InvariantCulture)
    return $time.AddMinutes(-$Minutes).ToString('yyyy-MM-ddTHH:mm:ss', [cultureinfo]::InvariantCulture)
}
