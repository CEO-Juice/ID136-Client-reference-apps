<#
.SYNOPSIS
    Reference integration between e-automate (through the ID136 API) and ServiceNow.

.DESCRIPTION
    Each run does one pass and exits; schedule it every few minutes.

      1. ServiceNow -> e-automate: new incidents in the assignment group become service calls.
      2. e-automate -> ServiceNow: new open service calls become incidents.
      3. e-automate -> ServiceNow: completed calls close their incident.

    Which call belongs to which incident is remembered in a JSON state file.
    Works in Windows PowerShell 5.1 and PowerShell 7+. Exit code 0 = everything synced, 1 = something failed.

    THIS IS A REFERENCE SCRIPT, NOT A PRODUCTION SERVICE. It is kept short so it is easy to read.
    Places where it takes a shortcut you should not ship are marked "PRODUCTION NOTE:"
    (search for that text). The README has the same list under "Before using this in production".

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Sync-ServiceCalls.ps1
#>

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 may not offer TLS 1.2 by default; both APIs require it.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

. (Join-Path $PSScriptRoot 'lib/Log.ps1')
. (Join-Path $PSScriptRoot 'lib/Settings.ps1')
. (Join-Path $PSScriptRoot 'lib/SyncState.ps1')
. (Join-Path $PSScriptRoot 'lib/Http.ps1')
. (Join-Path $PSScriptRoot 'lib/Id136.ps1')
. (Join-Path $PSScriptRoot 'lib/ServiceNow.ps1')

# Re-read this much before the watermark each run, in case of late-arriving changes.
# Anything already handled is skipped because it is in the state file.
$WatermarkOverlapMinutes = 15

$OpenStatuses = @('P', 'D', 'A', 'H')

# e-automate pads status codes with spaces ("I "), so compare them trimmed.
function Get-NormalizedStatus {
    param($Status)
    return ([string] $Status).Trim().ToUpperInvariant()
}

# ---------- 1. ServiceNow incident -> new e-automate call ----------
function Sync-IncidentsToCalls {
    param($Incidents, $Settings, $State, [string] $StatePath)

    $failures = 0
    foreach ($incident in $Incidents) {
        if (Find-LinkByIncident -State $State -SysId $incident.sys_id) { continue }  # already linked

        # e-automate finds the equipment (and so the customer) by serial number.
        $serial = $incident.'cmdb_ci.serial_number'
        if ([string]::IsNullOrWhiteSpace($serial)) {
            Write-Log WARN "Skipping $($incident.number): no configuration item with a serial number"
            continue
        }

        try {
            # PRODUCTION NOTE: the field mapping is minimal and nothing is shortened or cleaned up.
            # e-automate limits the description (about 210 characters after the reference prefix) and
            # the caller field; map the fields your process needs and trim them to fit.
            # Also, if a call already exists for this incident number (even a closed one), ID136
            # returns that call instead of creating a new one; check its status if that matters to you.
            $description = $incident.short_description
            if ([string]::IsNullOrWhiteSpace($description)) { $description = $incident.number }

            $newCall = @{
                description             = $description
                notes                   = $incident.description
                serialNumber            = $serial
                contact                 = ("$($incident.'caller_id.name') $($incident.'caller_id.email')").Trim()
                referenceCallIdentifier = $incident.number
            }
            if ($Settings.Id136.CallType) { $newCall.callType = $Settings.Id136.CallType }

            $call = New-Id136Call -Settings $Settings.Id136 -Call $newCall

            $State.Links += [pscustomobject][ordered]@{
                CallId         = $call.callId
                CallNumber     = $call.callNumber
                IncidentSysId  = $incident.sys_id
                IncidentNumber = $incident.number
                Direction      = 'FromServiceNow'
                Completed      = $false
                CreatedAt      = (Get-Date).ToString('o')
            }
            Save-SyncState -State $State -Path $StatePath  # save right away so a crash can't create it twice
            Write-Log INFO "Created call $($call.callNumber) from incident $($incident.number)"
        }
        catch {
            Write-Log ERROR "Could not create a call for incident $($incident.number): $_"
            $failures++
        }
    }
    return $failures
}

# ---------- 2. e-automate call -> new ServiceNow incident ----------
function Sync-CallsToIncidents {
    param($Calls, [string] $GroupId, $Settings, $State, [string] $StatePath)

    $failures = 0
    # PRODUCTION NOTE: every open call the API key can see becomes an incident. If the key covers
    # several customers or locations, filter here (e.g. by customerId or call type) so only the calls
    # meant for this ServiceNow instance are sent.
    $openCalls = @($Calls | Where-Object { $OpenStatuses -contains (Get-NormalizedStatus $_.status) })

    foreach ($call in $openCalls) {
        if (Find-LinkByCall -State $State -CallId $call.callId) { continue }  # already linked (including calls created in step 1)

        $serial = ''
        if ($call.equipment) { $serial = ([string] $call.equipment.serialNumber).Trim() }
        if (-not $serial) {
            Write-Log WARN "Skipping call $($call.callNumber): no equipment serial number"
            continue
        }

        try {
            $ci = Find-SnowCiBySerial -Settings $Settings.ServiceNow -SerialNumber $serial
            if (-not $ci) {
                Write-Log WARN "Call $($call.callNumber): no ServiceNow CI with serial $serial; creating the incident without one"
            }

            $shortDescription = $call.description
            if ([string]::IsNullOrWhiteSpace($shortDescription)) { $shortDescription = "Service call $($call.callNumber)" }

            # PRODUCTION NOTE: values are sent as-is. ServiceNow's short_description holds 160 characters
            # by default, and the caller, category and other required fields of your instance are not set.
            $incident = New-SnowIncident -Settings $Settings.ServiceNow -Fields @{
                short_description = $shortDescription
                description       = "e-automate service call $($call.callNumber)`n`n$($call.notes)"
                cmdb_ci           = $(if ($ci) { $ci.sys_id } else { $null })
                assignment_group  = $GroupId
                urgency           = $Settings.ServiceNow.Urgency
                impact            = $Settings.ServiceNow.Impact
            }

            $State.Links += [pscustomobject][ordered]@{
                CallId         = $call.callId
                CallNumber     = $call.callNumber
                IncidentSysId  = $incident.sys_id
                IncidentNumber = [string] $incident.number
                Direction      = 'FromEautomate'
                Completed      = $false
                CreatedAt      = (Get-Date).ToString('o')
            }
            Save-SyncState -State $State -Path $StatePath
            Write-Log INFO "Created incident $($incident.number) from call $($call.callNumber)"
        }
        catch {
            Write-Log ERROR "Could not create an incident for call $($call.callNumber): $_"
            $failures++
        }
    }
    return $failures
}

# ---------- 3. completed e-automate call -> close the ServiceNow incident ----------
function Close-CompletedIncidents {
    param($Calls, $Settings, $State, [string] $StatePath)

    $completedStatuses = @($Settings.Id136.CompletedStatuses | ForEach-Object { Get-NormalizedStatus $_ })
    $failures = 0

    foreach ($call in $Calls) {
        $link = Find-LinkByCall -State $State -CallId $call.callId
        if (-not $link -or $link.Completed) { continue }

        $status = Get-NormalizedStatus $call.status
        if ($completedStatuses -notcontains $status) { continue }

        try {
            # PRODUCTION NOTE: the e-automate call notes become the incident's close notes, which
            # ServiceNow users can read. If your notes can hold internal or sensitive text, filter them
            # or use a fixed message instead.
            $notes = $call.notes
            if ([string]::IsNullOrWhiteSpace($notes)) { $notes = "Completed in e-automate as call $($call.callNumber)" }

            Close-SnowIncident -Settings $Settings.ServiceNow -IncidentSysId $link.IncidentSysId -CloseNotes $notes

            $link.Completed = $true
            Save-SyncState -State $State -Path $StatePath
            Write-Log INFO "Closed incident $($link.IncidentNumber): call $($call.callNumber) is $status"
        }
        catch {
            Write-Log ERROR "Could not close incident $($link.IncidentNumber) for call $($call.callNumber): $_"
            $failures++
        }
    }
    return $failures
}

function Invoke-Sync {
    $settings = Read-Settings -AppDir $PSScriptRoot
    $missing = @(Get-MissingSettings -Settings $settings)
    if ($missing.Count -gt 0) {
        Write-Log ERROR "Missing settings in appsettings.json: $($missing -join ', ')"
        return 1
    }

    # PRODUCTION NOTE: nothing stops two runs from overlapping (e.g. a slow run when the scheduler
    # starts the next one). Both would read the same state file and could create the same call or
    # incident twice. Use a lock (a lock file, a named mutex, or "Do not start a new instance" in
    # Task Scheduler) so only one run happens at a time.
    $statePath = Join-Path $PSScriptRoot $settings.StateFile
    $state = Read-SyncState -Path $statePath

    try {
        Connect-ServiceNow -Settings $settings.ServiceNow
        $groupId = Get-SnowGroupId -Settings $settings.ServiceNow -GroupName $settings.ServiceNow.AssignmentGroup
        if (-not $groupId) {
            throw "Assignment group '$($settings.ServiceNow.AssignmentGroup)' not found in ServiceNow"
        }

        $failures = 0

        # 1. ServiceNow -> e-automate
        $incidents = @(Get-SnowActiveIncidents -Settings $settings.ServiceNow -GroupId $groupId)
        Write-Log INFO "$($incidents.Count) active incidents in '$($settings.ServiceNow.AssignmentGroup)'"
        $failures += Sync-IncidentsToCalls -Incidents $incidents -Settings $settings -State $state -StatePath $statePath

        # 2 and 3 use the same list of calls from ID136.
        $changedSince = $null
        if ($state.LastCallUpdateSeen) {
            $changedSince = Get-EautoTimeMinusMinutes -EautoTime $state.LastCallUpdateSeen -Minutes $WatermarkOverlapMinutes
        }
        $calls = @(Get-Id136Calls -Settings $settings.Id136 -ChangedSince $changedSince)
        if ($changedSince) {
            Write-Log INFO "$($calls.Count) calls changed in e-automate since $changedSince"
        }
        else {
            Write-Log INFO "$($calls.Count) open calls in e-automate (first run)"
        }

        $failures += Sync-CallsToIncidents -Calls $calls -GroupId $groupId -Settings $settings -State $state -StatePath $statePath
        $failures += Close-CompletedIncidents -Calls $calls -Settings $settings -State $state -StatePath $statePath

        # Only move the watermark forward when everything worked, so failed calls are read again next run.
        # PRODUCTION NOTE: one call that can never succeed (e.g. bad data) holds the watermark back for
        # good, so every run re-reads an ever-growing window. Track repeated failures per call, park them
        # after a few attempts (a "dead letter" list someone reviews), and let the watermark move on.
        if ($failures -eq 0 -and $calls.Count -gt 0) {
            # Same fixed-width text format, so a plain sort orders them correctly.
            $newest = $calls | ForEach-Object { ConvertTo-EautoTime $_.lastUpdate } | Sort-Object | Select-Object -Last 1
            if (-not $state.LastCallUpdateSeen -or $newest -gt $state.LastCallUpdateSeen) {
                $state.LastCallUpdateSeen = $newest
            }
        }
        Save-SyncState -State $state -Path $statePath

        if ($failures -eq 0) {
            Write-Log INFO 'Sync finished'
            return 0
        }
        Write-Log INFO "Sync finished with $failures failure(s); they will be retried next run"
        return 1
    }
    catch {
        # PRODUCTION NOTE: failures only show up in the console output and the exit code.
        # Send them somewhere someone will see (alerting, monitoring, email).
        Write-Log ERROR "Sync stopped: $_"
        return 1
    }
}

exit (Invoke-Sync)
