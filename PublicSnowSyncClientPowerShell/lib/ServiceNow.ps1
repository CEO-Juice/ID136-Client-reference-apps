# Talks to the ServiceNow Table API (api/now/table/...). Authenticates once per run
# with the OAuth password grant and sends the token on every request.

$SnowPageSize = 500

# "Dot-walked" fields (cmdb_ci.serial_number, caller_id.*) bring in values from the linked
# CI and caller records, so no extra lookups are needed.
$SnowIncidentFields = 'sys_id,number,short_description,description,cmdb_ci.serial_number,caller_id.name,caller_id.email'

$script:SnowAccessToken = $null

# PRODUCTION NOTE: the password grant needs an integration user's password, and the token is
# fetched once and never refreshed (fine for a short run; ServiceNow tokens last about 30 minutes).
# Prefer an auth method without a stored user password (e.g. OAuth client credentials or JWT bearer,
# if your instance allows it), refresh the token before it expires, and give the integration user
# only the roles it needs.
function Connect-ServiceNow {
    param($Settings)

    $request = @{
        Uri        = "$($Settings.BaseUrl.TrimEnd('/'))/oauth_token.do"
        Method     = 'Post'
        Body       = @{
            grant_type    = 'password'
            client_id     = $Settings.ClientId
            client_secret = $Settings.ClientSecret
            username      = $Settings.Username
            password      = $Settings.Password
        }
        TimeoutSec = 60
    }
    $script:SnowAccessToken = (Invoke-Api -Name 'ServiceNow' -Request $request).access_token
}

function Get-SnowGroupId {
    param($Settings, [string] $GroupName)
    $groups = @(Get-SnowRecords -Settings $Settings -Table 'sys_user_group' -Query "name=$GroupName" -Fields 'sys_id' -Limit 1)
    if ($groups.Count -eq 0) { return $null }
    return $groups[0].sys_id
}

# Active incidents assigned to the group, skipping the excluded states. Read every run;
# the state file tells us which ones are new.
# PRODUCTION NOTE: reading every active incident each run is simple but grows with the queue.
# For a busy group, also filter on sys_updated_on (with an overlap) so each run reads only recent changes.
function Get-SnowActiveIncidents {
    param($Settings, [string] $GroupId)

    $query = "active=true^assignment_group=$GroupId"
    foreach ($state in @($Settings.ExcludedStates)) {
        $query += "^state!=$state"
    }
    $query += '^ORDERBYsys_id'  # stable order so paging doesn't skip or repeat records

    $incidents = @()
    $offset = 0
    while ($true) {
        $page = @(Get-SnowRecords -Settings $Settings -Table 'incident' -Query $query -Fields $SnowIncidentFields `
                -Limit $SnowPageSize -Offset $offset)
        $incidents += $page
        if ($page.Count -lt $SnowPageSize) { return $incidents }
        $offset += $SnowPageSize
    }
}

function Find-SnowCiBySerial {
    param($Settings, [string] $SerialNumber)
    # "^" would start a new condition in the query, so never pass it through.
    if ($SerialNumber.Contains('^')) { return $null }
    $cis = @(Get-SnowRecords -Settings $Settings -Table 'cmdb_ci' -Query "serial_number=$SerialNumber" -Fields 'sys_id' -Limit 1)
    if ($cis.Count -eq 0) { return $null }
    return $cis[0]
}

# Returns the new incident's sys_id and number.
function New-SnowIncident {
    param($Settings, [hashtable] $Fields)
    # Leave out empty fields (e.g. no matching CI) rather than sending null.
    $body = @{}
    foreach ($key in $Fields.Keys) {
        if ($null -ne $Fields[$key]) { $body[$key] = $Fields[$key] }
    }
    return Invoke-ServiceNow -Settings $Settings -Method Post `
        -RelativeUrl 'api/now/table/incident?sysparm_fields=sys_id,number' -Body $body
}

function Close-SnowIncident {
    param($Settings, [string] $IncidentSysId, [string] $CloseNotes)
    $body = @{
        state       = $Settings.ClosedState
        close_code  = $Settings.CloseCode
        close_notes = $CloseNotes
    }
    [void] (Invoke-ServiceNow -Settings $Settings -Method Patch `
        -RelativeUrl "api/now/table/incident/$($IncidentSysId)?sysparm_fields=sys_id" -Body $body)
}

# GET api/now/table/{table} with an encoded query.
function Get-SnowRecords {
    param($Settings, [string] $Table, [string] $Query, [string] $Fields, [int] $Limit, [int] $Offset = 0)
    $url = "api/now/table/$($Table)" +
           "?sysparm_query=$([uri]::EscapeDataString($Query))" +
           "&sysparm_fields=$([uri]::EscapeDataString($Fields))" +
           "&sysparm_limit=$Limit&sysparm_offset=$Offset"
    return Invoke-ServiceNow -Settings $Settings -Method Get -RelativeUrl $url
}

# ServiceNow wraps every response body in { "result": ... }.
# PRODUCTION NOTE: no retries (see the same note in Id136.ps1).
function Invoke-ServiceNow {
    param($Settings, [string] $Method, [string] $RelativeUrl, $Body)

    if (-not $script:SnowAccessToken) { throw 'Call Connect-ServiceNow first' }

    $request = @{
        Uri        = "$($Settings.BaseUrl.TrimEnd('/'))/$RelativeUrl"
        Method     = $Method
        Headers    = @{ Authorization = "Bearer $script:SnowAccessToken"; Accept = 'application/json' }
        TimeoutSec = 60
    }
    if ($null -ne $Body) {
        $request.Body = ConvertTo-JsonBody $Body
        $request.ContentType = 'application/json; charset=utf-8'
    }
    return (Invoke-Api -Name 'ServiceNow' -Request $request).result
}
