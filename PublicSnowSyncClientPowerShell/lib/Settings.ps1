# Reads appsettings.json, then appsettings.local.json (optional, not committed) on top of it
# for real secrets. Both files live in the script folder.
# PRODUCTION NOTE: secrets in a plain JSON file are readable by anyone who can read the folder.
# Load them from a secret store instead (Windows Credential Manager / SecretManagement module,
# DPAPI-encrypted files, Azure Key Vault, ...), and never commit them.

function Read-Settings {
    param([string] $AppDir)

    $settings = Get-Content -Raw -Path (Join-Path $AppDir 'appsettings.json') | ConvertFrom-Json
    $localPath = Join-Path $AppDir 'appsettings.local.json'
    if (Test-Path $localPath) {
        Merge-Settings -Target $settings -Source (Get-Content -Raw -Path $localPath | ConvertFrom-Json)
    }
    return $settings
}

# Copies values from Source into Target; nested sections are merged, everything else replaced.
function Merge-Settings {
    param($Target, $Source)

    foreach ($property in $Source.PSObject.Properties) {
        # Note: "-is [pscustomobject]" is true for every object, so test the real type.
        $sectionType = [System.Management.Automation.PSCustomObject]
        $existing = $Target.PSObject.Properties[$property.Name]
        if ($existing -and $existing.Value -is $sectionType -and $property.Value -is $sectionType) {
            Merge-Settings -Target $existing.Value -Source $property.Value
        }
        else {
            $Target | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
        }
    }
}

# Returns the names of required settings that are still empty or placeholders.
# PRODUCTION NOTE: this only checks that values are present. It does not check that the base URLs
# use https (they should; the API key and passwords travel in every request), or that the assignment
# group and state values are sensible. Validate them before you rely on them.
function Get-MissingSettings {
    param($Settings)

    $required = [ordered]@{
        'Id136:BaseUrl'              = $Settings.Id136.BaseUrl
        'Id136:ApiKey'               = $Settings.Id136.ApiKey
        'ServiceNow:BaseUrl'         = $Settings.ServiceNow.BaseUrl
        'ServiceNow:ClientId'        = $Settings.ServiceNow.ClientId
        'ServiceNow:ClientSecret'    = $Settings.ServiceNow.ClientSecret
        'ServiceNow:Username'        = $Settings.ServiceNow.Username
        'ServiceNow:Password'        = $Settings.ServiceNow.Password
        'ServiceNow:AssignmentGroup' = $Settings.ServiceNow.AssignmentGroup
    }

    $missing = @()
    foreach ($name in $required.Keys) {
        $value = [string] $required[$name]
        if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith('<')) {
            $missing += $name
        }
    }
    if (@($Settings.Id136.CompletedStatuses).Count -eq 0) {
        $missing += 'Id136:CompletedStatuses'
    }
    return $missing
}
