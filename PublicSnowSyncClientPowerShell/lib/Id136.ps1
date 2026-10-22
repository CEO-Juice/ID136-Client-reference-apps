# Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
# Every request carries either the API key in the "eaapikey" header or, when a username is set,
# a bearer token from POST api/auth/token. JSON property names are camelCase.
#
# A service call looks like:
#   { callId, callNumber, status, description, notes, caller, date, closeDate, lastUpdate,
#     equipment: { serialNumber, equipmentNumber } }   # equipment only with includeDetails=true
# status is padded with spaces in e-automate ("I "), so always compare it trimmed.

$Id136PageSize = 1000  # the API maximum

# Tokens last 60 minutes and can't be refreshed; get a new one when this little is left.
$Id136TokenRenewBefore = [TimeSpan]::FromMinutes(5)
$script:Id136Token = $null
$script:Id136TokenExpiresUtc = [DateTime]::MinValue

# True when the settings ask for a bearer token (username and password) rather than an API key.
function Test-Id136UsesToken {
    param($Settings)
    $username = [string] $Settings.Username
    return -not [string]::IsNullOrWhiteSpace($username) -and -not $username.StartsWith('<')
}

# With no watermark: all open calls. Otherwise: every call changed since then,
# in any status (open, completed, canceled). includeDetails adds the equipment serial.
function Get-Id136Calls {
    param($Settings, [string] $ChangedSince)

    if ($ChangedSince) {
        $path = "api/ServiceCall/Recentchanges/$ChangedSince"
    }
    else {
        $path = 'api/ServiceCall/AllOpen/'
    }

    # List endpoints return one page at a time: { page, pageSize, totalCount, totalPages, items }
    $calls = @()
    $page = 1
    do {
        $result = Invoke-Id136 -Settings $Settings -Method Get `
            -RelativeUrl "$($path)?page=$page&pageSize=$Id136PageSize&includeDetails=true"
        $calls += @($result.items)
        $totalPages = [int] $result.totalPages
        $page++
    } while ($page -le $totalPages)

    return $calls
}

# Creates an e-automate call and returns it (with its new callId and callNumber).
# The equipment, and so the customer, is found by serialNumber. referenceCallIdentifier is
# required: if a call with that reference already exists, the API returns it instead.
function New-Id136Call {
    param($Settings, [hashtable] $Call)
    $Call['callDate'] = (Get-Date).ToString('o')
    return Invoke-Id136 -Settings $Settings -Method Put -RelativeUrl 'api/ServiceCall/AddCall/' -Body $Call
}

# PRODUCTION NOTE: no retries. A timeout, HTTP 429 (rate limited) or 5xx fails the item and it is
# tried again next run. Add retries with backoff and respect the Retry-After header.
function Invoke-Id136 {
    param($Settings, [string] $Method, [string] $RelativeUrl, $Body)

    if (Test-Id136UsesToken $Settings) {
        $headers = @{ Authorization = "Bearer $(Get-Id136Token $Settings)"; Accept = 'application/json' }
    }
    else {
        $headers = @{ eaapikey = $Settings.ApiKey; Accept = 'application/json' }
    }

    $request = @{
        Uri        = "$($Settings.BaseUrl.TrimEnd('/'))/$RelativeUrl"
        Method     = $Method
        Headers    = $headers
        TimeoutSec = 60
    }
    if ($null -ne $Body) {
        $request.Body = ConvertTo-JsonBody $Body
        $request.ContentType = 'application/json; charset=utf-8'
    }
    return Invoke-Api -Name 'ID136' -Request $request
}

# Exchanges the username and password for a bearer token, reusing it until it is about to expire.
# PRODUCTION NOTE: the token endpoint is rate limited, so keep reusing the token rather than
# asking for one per request, and keep the password in a secret store, not in appsettings.
function Get-Id136Token {
    param($Settings)

    if ($script:Id136Token -and (Get-Date).ToUniversalTime() -lt $script:Id136TokenExpiresUtc - $Id136TokenRenewBefore) {
        return $script:Id136Token
    }

    $request = @{
        Uri         = "$($Settings.BaseUrl.TrimEnd('/'))/api/auth/token"
        Method      = 'Post'
        Headers     = @{ Accept = 'application/json' }
        Body        = ConvertTo-JsonBody @{ username = $Settings.Username; password = $Settings.Password }
        ContentType = 'application/json; charset=utf-8'
        TimeoutSec  = 60
    }
    $result = Invoke-Api -Name 'ID136' -Request $request
    $script:Id136Token = $result.token
    # PowerShell 7 already parses "expires" into a DateTime; Windows PowerShell 5.1 leaves it a string.
    $script:Id136TokenExpiresUtc = ([DateTime] $result.expires).ToUniversalTime()
    return $script:Id136Token
}
