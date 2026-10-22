using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace PublicSnowSyncClient;

// Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
// Every request carries either the API key in the "eaapikey" header or, when a username is set,
// a bearer token from POST api/auth/token.
public class Id136Client(HttpClient http, Id136Settings settings)
{
    // camelCase JSON, matched case-insensitively.
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const int PageSize = 1000; // the API maximum

    // Tokens last 60 minutes and can't be refreshed; get a new one when this little is left.
    private static readonly TimeSpan TokenRenewBefore = TimeSpan.FromMinutes(5);

    private string? token;
    private DateTime tokenExpiresUtc;

    // With no watermark: all open calls. Otherwise: every call changed since then,
    // in any status (open, completed, canceled). includeDetails adds the equipment serial.
    public async Task<List<ServiceCall>> GetCallsAsync(DateTime? changedSince)
    {
        string path = changedSince == null
            ? "api/ServiceCall/AllOpen/"
            : $"api/ServiceCall/Recentchanges/{changedSince:yyyy-MM-ddTHH:mm:ss}";

        var calls = new List<ServiceCall>();
        int page = 1;
        int totalPages;
        do
        {
            var request = await CreateRequestAsync(HttpMethod.Get, $"{path}?page={page}&pageSize={PageSize}&includeDetails=true");
            using var response = await http.SendAsync(request);
            await EnsureSuccessAsync(response);

            var result = await response.Content.ReadFromJsonAsync<PagedResult<ServiceCall>>(Json)
                ?? throw new InvalidOperationException("Empty response from ID136");
            calls.AddRange(result.Items);
            totalPages = result.TotalPages;
            page++;
        } while (page <= totalPages);

        return calls;
    }

    // Creates an e-automate call and returns it (with its new callId and callNumber).
    public async Task<ServiceCall> AddCallAsync(NewServiceCall newCall)
    {
        var request = await CreateRequestAsync(HttpMethod.Put, "api/ServiceCall/AddCall/");
        request.Content = new StringContent(JsonSerializer.Serialize(newCall, Json), Encoding.UTF8, "application/json");

        using var response = await http.SendAsync(request);
        await EnsureSuccessAsync(response);

        return await response.Content.ReadFromJsonAsync<ServiceCall>(Json)
            ?? throw new InvalidOperationException("Empty response from ID136 AddCall");
    }

    private async Task<HttpRequestMessage> CreateRequestAsync(HttpMethod method, string relativeUrl)
    {
        var request = new HttpRequestMessage(method, Url(relativeUrl));
        if (settings.UsesToken)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetTokenAsync());
        else
            request.Headers.Add("eaapikey", settings.ApiKey);
        return request;
    }

    // Exchanges the username and password for a bearer token, reusing it until it is about to expire.
    // PRODUCTION NOTE: the token endpoint is rate limited, so keep reusing the token rather than
    // asking for one per request, and keep the password in a secret store, not in appsettings.
    private async Task<string> GetTokenAsync()
    {
        if (token != null && DateTime.UtcNow < tokenExpiresUtc - TokenRenewBefore)
            return token;

        using var response = await http.PostAsJsonAsync(Url("api/auth/token"),
            new { username = settings.Username, password = settings.Password }, Json);
        await EnsureSuccessAsync(response);

        var result = await response.Content.ReadFromJsonAsync<TokenResponse>(Json)
            ?? throw new InvalidOperationException("Empty response from ID136 token");
        token = result.Token;
        tokenExpiresUtc = result.Expires.ToUniversalTime();
        return token;
    }

    private string Url(string relativeUrl) => $"{settings.BaseUrl.TrimEnd('/')}/{relativeUrl}";

    private record TokenResponse(string Token, DateTime Expires);

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            string body = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"ID136 {(int)response.StatusCode} {response.RequestMessage?.RequestUri}: {body}");
        }
    }
}
