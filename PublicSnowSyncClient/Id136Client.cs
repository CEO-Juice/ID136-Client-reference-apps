using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace PublicSnowSyncClient;

// Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
// Every request carries the API key in the "eaapikey" header.
public class Id136Client(HttpClient http, Id136Settings settings)
{
    // camelCase JSON, matched case-insensitively.
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const int PageSize = 1000; // the API maximum

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
            var request = CreateRequest(HttpMethod.Get, $"{path}?page={page}&pageSize={PageSize}&includeDetails=true");
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
        var request = CreateRequest(HttpMethod.Put, "api/ServiceCall/AddCall/");
        request.Content = new StringContent(JsonSerializer.Serialize(newCall, Json), Encoding.UTF8, "application/json");

        using var response = await http.SendAsync(request);
        await EnsureSuccessAsync(response);

        return await response.Content.ReadFromJsonAsync<ServiceCall>(Json)
            ?? throw new InvalidOperationException("Empty response from ID136 AddCall");
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string relativeUrl)
    {
        var request = new HttpRequestMessage(method, $"{settings.BaseUrl.TrimEnd('/')}/{relativeUrl}");
        request.Headers.Add("eaapikey", settings.ApiKey);
        return request;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            string body = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"ID136 {(int)response.StatusCode} {response.RequestMessage?.RequestUri}: {body}");
        }
    }
}
