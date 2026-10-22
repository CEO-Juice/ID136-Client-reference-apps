using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace PublicSnowSyncClient;

// Talks to the ServiceNow Table API (api/now/table/...). Authenticates once per run
// with the OAuth password grant and sends the token on every request.
public class ServiceNowClient(HttpClient http, ServiceNowSettings settings)
{
    private const int PageSize = 500;
    private const string IncidentFields = "sys_id,number,short_description,description,cmdb_ci.serial_number,caller_id.name,caller_id.email";

    private string? accessToken;

    // PRODUCTION NOTE: the password grant needs an integration user's password, and the token is
    // fetched once and never refreshed (fine for a short run; ServiceNow tokens last about 30 minutes).
    // Prefer an auth method without a stored user password (e.g. OAuth client credentials or JWT bearer,
    // if your instance allows it), refresh the token before it expires, and give the integration user
    // only the roles it needs.
    public async Task ConnectAsync()
    {
        var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "password",
            ["client_id"] = settings.ClientId,
            ["client_secret"] = settings.ClientSecret,
            ["username"] = settings.Username,
            ["password"] = settings.Password,
        });

        using var response = await http.PostAsync(Url("oauth_token.do"), form);
        await EnsureSuccessAsync(response);

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        accessToken = json.RootElement.GetProperty("access_token").GetString();
    }

    public async Task<string?> GetGroupIdAsync(string groupName)
    {
        var groups = await QueryAsync<SnowRecord>("sys_user_group", $"name={groupName}", "sys_id", limit: 1);
        return groups.FirstOrDefault()?.SysId;
    }

    // Active incidents assigned to the group, skipping the excluded states. Read every run;
    // the state file tells us which ones are new.
    // PRODUCTION NOTE: reading every active incident each run is simple but grows with the queue.
    // For a busy group, also filter on sys_updated_on (with an overlap) so each run reads only recent changes.
    public async Task<List<Incident>> GetActiveIncidentsAsync(string groupId, IEnumerable<string> excludedStates)
    {
        string query = $"active=true^assignment_group={groupId}";
        foreach (var state in excludedStates)
            query += $"^state!={state}";
        query += "^ORDERBYsys_id"; // stable order so paging doesn't skip or repeat records

        var incidents = new List<Incident>();
        int offset = 0;
        while (true)
        {
            var page = await QueryAsync<Incident>("incident", query, IncidentFields, PageSize, offset);
            incidents.AddRange(page);
            if (page.Count < PageSize)
                return incidents;
            offset += PageSize;
        }
    }

    public async Task<SnowRecord?> FindCiBySerialAsync(string serialNumber)
    {
        // "^" would start a new condition in the query, so never pass it through.
        if (serialNumber.Contains('^'))
            return null;
        var cis = await QueryAsync<SnowRecord>("cmdb_ci", $"serial_number={serialNumber}", "sys_id", limit: 1);
        return cis.FirstOrDefault();
    }

    public async Task<SnowRecord> CreateIncidentAsync(Dictionary<string, string?> fields)
    {
        var request = CreateRequest(HttpMethod.Post, "api/now/table/incident?sysparm_fields=sys_id,number");
        // Leave out empty fields (e.g. no matching CI) rather than sending null.
        request.Content = JsonBody(fields.Where(f => f.Value != null).ToDictionary());
        return await SendForResultAsync<SnowRecord>(request);
    }

    public async Task CloseIncidentAsync(string incidentSysId, string closeNotes)
    {
        var fields = new Dictionary<string, string>
        {
            ["state"] = settings.ClosedState,
            ["close_code"] = settings.CloseCode,
            ["close_notes"] = closeNotes,
        };
        var request = CreateRequest(HttpMethod.Patch, $"api/now/table/incident/{incidentSysId}?sysparm_fields=sys_id");
        request.Content = JsonBody(fields);
        await SendForResultAsync<SnowRecord>(request);
    }

    // GET api/now/table/{table} with an encoded query; returns the "result" array.
    private async Task<List<T>> QueryAsync<T>(string table, string query, string fields, int limit, int offset = 0)
    {
        string url = $"api/now/table/{table}" +
                     $"?sysparm_query={Uri.EscapeDataString(query)}" +
                     $"&sysparm_fields={Uri.EscapeDataString(fields)}" +
                     $"&sysparm_limit={limit}&sysparm_offset={offset}";
        return await SendForResultAsync<List<T>>(CreateRequest(HttpMethod.Get, url));
    }

    // ServiceNow wraps every response body in { "result": ... }.
    private async Task<T> SendForResultAsync<T>(HttpRequestMessage request)
    {
        using var response = await http.SendAsync(request);
        await EnsureSuccessAsync(response);

        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return json.RootElement.GetProperty("result").Deserialize<T>()
            ?? throw new InvalidOperationException("Empty result from ServiceNow");
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string relativeUrl)
    {
        if (accessToken == null)
            throw new InvalidOperationException("Call ConnectAsync first");

        var request = new HttpRequestMessage(method, Url(relativeUrl));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return request;
    }

    private string Url(string relativeUrl) => $"{settings.BaseUrl.TrimEnd('/')}/{relativeUrl}";

    // Serialized up front so the request has a Content-Length.
    private static StringContent JsonBody(object value) =>
        new(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json");

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            string body = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"ServiceNow {(int)response.StatusCode} {response.RequestMessage?.RequestUri}: {body}");
        }
    }
}
