# Helpers shared by the ID136 and ServiceNow functions.

# Send a request, and turn an HTTP error into one message with the status code and response body.
function Invoke-Api {
    param([string] $Name, [hashtable] $Request)
    try {
        return Invoke-RestMethod @Request
    }
    catch {
        $status = ''
        if ($_.Exception.Response) { $status = [int] $_.Exception.Response.StatusCode }
        throw "$Name $status $($Request.Uri): $($_.ErrorDetails.Message) $($_.Exception.Message)"
    }
}

# JSON as UTF-8 bytes, so non-English text arrives intact in Windows PowerShell 5.1 too.
function ConvertTo-JsonBody {
    param($Value)
    return [System.Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 5 -Compress))
}
