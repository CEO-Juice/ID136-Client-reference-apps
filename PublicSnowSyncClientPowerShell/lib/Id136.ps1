# Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
# Every request carries the API key in the "eaapikey" header. JSON property names are camelCase.
#
# A service call looks like:
#   { callId, callNumber, status, description, notes, caller, date, closeDate, lastUpdate,
#     equipment: { serialNumber, equipmentNumber } }   # equipment only with includeDetails=true
# status is padded with spaces in e-automate ("I "), so always compare it trimmed.

$Id136PageSize = 1000  # the API maximum

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

    $request = @{
        Uri        = "$($Settings.BaseUrl.TrimEnd('/'))/$RelativeUrl"
        Method     = $Method
        Headers    = @{ eaapikey = $Settings.ApiKey; Accept = 'application/json' }
        TimeoutSec = 60
    }
    if ($null -ne $Body) {
        $request.Body = ConvertTo-JsonBody $Body
        $request.ContentType = 'application/json; charset=utf-8'
    }
    return Invoke-Api -Name 'ID136' -Request $request
}
