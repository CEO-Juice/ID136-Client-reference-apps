using System.Text.Json.Serialization;

namespace PublicSnowSyncClient;

// ---------- ID136 (e-automate) API ----------
// The API returns camelCase JSON; Id136Client reads it case-insensitively.

// List endpoints return one page at a time in this envelope.
public class PagedResult<T>
{
    public int Page { get; set; }
    public int TotalPages { get; set; }
    public List<T> Items { get; set; } = [];
}

public class ServiceCall
{
    public int CallId { get; set; }
    public string CallNumber { get; set; } = "";

    // Padded with spaces in e-automate ("I "), so always compare it trimmed.
    public string? Status { get; set; }
    public string? Description { get; set; }
    public string? Notes { get; set; }
    public string? Caller { get; set; }
    public DateTime? Date { get; set; }
    public DateTime? CloseDate { get; set; }

    // e-automate server time of the last change. Used as the sync watermark.
    public DateTime LastUpdate { get; set; }

    // Only filled when requested with includeDetails=true.
    public CallEquipment? Equipment { get; set; }

    public bool IsOpen => Status?.Trim().ToUpperInvariant() is "P" or "D" or "A" or "H";
}

public class CallEquipment
{
    public string? SerialNumber { get; set; }
    public string? EquipmentNumber { get; set; }
}

// Body for PUT api/ServiceCall/AddCall/. The equipment is found by SerialNumber.
public class NewServiceCall
{
    public string Description { get; set; } = "";
    public string? Notes { get; set; }
    public string? SerialNumber { get; set; }
    public string? Contact { get; set; }
    public string? CallType { get; set; }

    // Required by the API. If a call with this reference already exists, the API
    // returns that call instead of creating a new one.
    public string ReferenceCallIdentifier { get; set; } = "";
    public DateTime CallDate { get; set; } = DateTime.Now;
}

// ---------- ServiceNow Table API ----------

public class Incident
{
    [JsonPropertyName("sys_id")] public string SysId { get; set; } = "";
    [JsonPropertyName("number")] public string Number { get; set; } = "";
    [JsonPropertyName("short_description")] public string? ShortDescription { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }

    // "Dot-walked" fields: values from the linked CI and caller records,
    // requested with sysparm_fields so no extra lookups are needed.
    [JsonPropertyName("cmdb_ci.serial_number")] public string? CiSerialNumber { get; set; }
    [JsonPropertyName("caller_id.name")] public string? CallerName { get; set; }
    [JsonPropertyName("caller_id.email")] public string? CallerEmail { get; set; }
}

// A ServiceNow record reduced to the fields this app needs (CIs, groups).
public class SnowRecord
{
    [JsonPropertyName("sys_id")] public string SysId { get; set; } = "";
    [JsonPropertyName("number")] public string? Number { get; set; }
}
