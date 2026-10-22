namespace PublicSnowSyncClient;

// Bound from appsettings.json (and appsettings.local.json, which overrides it).
public class Settings
{
    public Id136Settings Id136 { get; set; } = new();
    public ServiceNowSettings ServiceNow { get; set; } = new();

    // Where the app remembers which calls and incidents it has already linked.
    public string StateFile { get; set; } = "sync-state.json";

    // Returns the names of required settings that are still empty or placeholders.
    // PRODUCTION NOTE: this only checks that values are present. It does not check that the base URLs
    // use https (they should; the API key and passwords travel in every request), or that the assignment
    // group and state values are sensible. Validate them before you rely on them.
    public List<string> FindMissing()
    {
        var missing = new List<string>();
        void Check(string name, string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.StartsWith('<'))
                missing.Add(name);
        }

        Check("Id136:BaseUrl", Id136.BaseUrl);
        Check("Id136:ApiKey", Id136.ApiKey);
        Check("ServiceNow:BaseUrl", ServiceNow.BaseUrl);
        Check("ServiceNow:ClientId", ServiceNow.ClientId);
        Check("ServiceNow:ClientSecret", ServiceNow.ClientSecret);
        Check("ServiceNow:Username", ServiceNow.Username);
        Check("ServiceNow:Password", ServiceNow.Password);
        Check("ServiceNow:AssignmentGroup", ServiceNow.AssignmentGroup);
        if (Id136.CompletedStatuses.Count == 0)
            missing.Add("Id136:CompletedStatuses");
        return missing;
    }
}

public class Id136Settings
{
    // e.g. https://api.ceojuice.com/  (your dealer gives you this and the API key)
    public string BaseUrl { get; set; } = "";
    public string ApiKey { get; set; } = "";

    // e-automate call type code for calls created from ServiceNow incidents (optional).
    public string CallType { get; set; } = "";

    // e-automate call status codes that mean "done" (OKB, I, CMP, C). Open calls are P, D, A and H.
    // List defaults live in appsettings.json: the config binder adds to a list rather than replacing it.
    public List<string> CompletedStatuses { get; set; } = [];
}

public class ServiceNowSettings
{
    // e.g. https://yourinstance.service-now.com/
    public string BaseUrl { get; set; } = "";
    public string ClientId { get; set; } = "";
    public string ClientSecret { get; set; } = "";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";

    // Name of the assignment group whose incidents become e-automate calls,
    // and which new incidents are assigned to.
    public string AssignmentGroup { get; set; } = "";

    // Incident states skipped when reading incidents (6 = Resolved). Empty = skip none.
    public List<string> ExcludedStates { get; set; } = [];

    // Values used when creating an incident.
    public string Urgency { get; set; } = "3";
    public string Impact { get; set; } = "2";

    // Values used when closing an incident because its e-automate call was completed.
    public string ClosedState { get; set; } = "6";
    public string CloseCode { get; set; } = "Solved (Permanently)";
}
