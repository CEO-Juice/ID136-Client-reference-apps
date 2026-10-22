using Microsoft.Extensions.Configuration;

namespace PublicSnowSyncClient;

// Reference integration between e-automate (through the ID136 API) and ServiceNow.
// Each run does one pass and exits; schedule it every few minutes.
//
//   1. ServiceNow -> e-automate: new incidents in the assignment group become service calls.
//   2. e-automate -> ServiceNow: new open service calls become incidents.
//   3. e-automate -> ServiceNow: completed calls close their incident.
//
// Which call belongs to which incident is remembered in a JSON state file.
//
// THIS IS A REFERENCE APP, NOT A PRODUCTION SERVICE. It is kept short so it is easy to read.
// Places where it takes a shortcut you should not ship are marked "PRODUCTION NOTE:"
// (search for that text). The README has the same list under "Before using this in production".
internal class Program
{
    // Re-read this much before the watermark each run, in case of late-arriving changes.
    // Anything already handled is skipped because it is in the state file.
    private static readonly TimeSpan WatermarkOverlap = TimeSpan.FromMinutes(15);

    static async Task<int> Main()
    {
        var settings = LoadSettings();
        var missing = settings.FindMissing();
        if (missing.Count > 0)
        {
            Log.Error("Missing settings in appsettings.json: " + string.Join(", ", missing));
            return 1;
        }

        // PRODUCTION NOTE: nothing stops two runs from overlapping (e.g. a slow run when the scheduler
        // starts the next one). Both would read the same state file and could create the same call or
        // incident twice. Use a lock (a lock file, a named mutex, or "do not start a new instance" in
        // the scheduler) so only one run happens at a time.
        string statePath = Path.Combine(AppContext.BaseDirectory, settings.StateFile);
        var state = SyncState.Load(statePath);

        // PRODUCTION NOTE: no retries. A timeout, HTTP 429 (rate limited) or 5xx fails the item and it
        // is tried again next run. Add retries with backoff (e.g. Polly or Microsoft.Extensions.Http.Resilience)
        // and respect the Retry-After header.
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
        var id136 = new Id136Client(http, settings.Id136);
        var snow = new ServiceNowClient(http, settings.ServiceNow);

        try
        {
            await snow.ConnectAsync();
            string groupId = await snow.GetGroupIdAsync(settings.ServiceNow.AssignmentGroup)
                ?? throw new InvalidOperationException($"Assignment group '{settings.ServiceNow.AssignmentGroup}' not found in ServiceNow");

            int failures = 0;

            // 1. ServiceNow -> e-automate
            var incidents = await snow.GetActiveIncidentsAsync(groupId, settings.ServiceNow.ExcludedStates);
            Log.Info($"{incidents.Count} active incidents in '{settings.ServiceNow.AssignmentGroup}'");
            failures += await CreateCallsFromIncidentsAsync(incidents, id136, settings, state, statePath);

            // 2 and 3 use the same list of calls from ID136.
            DateTime? changedSince = state.LastCallUpdateSeen - WatermarkOverlap;
            var calls = await id136.GetCallsAsync(changedSince);
            Log.Info(changedSince == null
                ? $"{calls.Count} open calls in e-automate (first run)"
                : $"{calls.Count} calls changed in e-automate since {changedSince:yyyy-MM-dd HH:mm}");

            failures += await CreateIncidentsFromCallsAsync(calls, snow, groupId, settings, state, statePath);
            failures += await CloseCompletedIncidentsAsync(calls, snow, settings, state, statePath);

            // Only move the watermark forward when everything worked, so failed calls are read again next run.
            // PRODUCTION NOTE: one call that can never succeed (e.g. bad data) holds the watermark back for
            // good, so every run re-reads an ever-growing window. Track repeated failures per call, park them
            // after a few attempts (a "dead letter" list someone reviews), and let the watermark move on.
            if (failures == 0 && calls.Count > 0)
            {
                DateTime newest = calls.Max(c => c.LastUpdate);
                if (state.LastCallUpdateSeen == null || newest > state.LastCallUpdateSeen)
                    state.LastCallUpdateSeen = newest;
            }
            state.Save(statePath);

            Log.Info(failures == 0 ? "Sync finished" : $"Sync finished with {failures} failure(s); they will be retried next run");
            return failures == 0 ? 0 : 1;
        }
        catch (Exception ex)
        {
            // PRODUCTION NOTE: failures only show up in the console output and the exit code.
            // Send them somewhere someone will see (alerting, monitoring, email).
            Log.Error("Sync stopped: " + ex.Message);
            return 1;
        }
    }

    // ---------- 1. ServiceNow incident -> new e-automate call ----------
    private static async Task<int> CreateCallsFromIncidentsAsync(
        List<Incident> incidents, Id136Client id136, Settings settings, SyncState state, string statePath)
    {
        int failures = 0;
        foreach (var incident in incidents)
        {
            if (state.FindByIncident(incident.SysId) != null)
                continue; // already linked

            // e-automate finds the equipment (and so the customer) by serial number.
            if (string.IsNullOrWhiteSpace(incident.CiSerialNumber))
            {
                Log.Warn($"Skipping {incident.Number}: no configuration item with a serial number");
                continue;
            }

            try
            {
                // PRODUCTION NOTE: the field mapping is minimal and nothing is shortened or cleaned up.
                // e-automate limits the description (about 210 characters after the reference prefix) and
                // the caller field; map the fields your process needs and trim them to fit.
                // Also, if a call already exists for this incident number (even a closed one), ID136
                // returns that call instead of creating a new one; check its status if that matters to you.
                var call = await id136.AddCallAsync(new NewServiceCall
                {
                    Description = incident.ShortDescription ?? incident.Number,
                    Notes = incident.Description,
                    SerialNumber = incident.CiSerialNumber,
                    Contact = $"{incident.CallerName} {incident.CallerEmail}".Trim(),
                    CallType = string.IsNullOrWhiteSpace(settings.Id136.CallType) ? null : settings.Id136.CallType,
                    ReferenceCallIdentifier = incident.Number,
                });

                state.Links.Add(new SyncLink
                {
                    CallId = call.CallId,
                    CallNumber = call.CallNumber,
                    IncidentSysId = incident.SysId,
                    IncidentNumber = incident.Number,
                    Direction = "FromServiceNow",
                });
                state.Save(statePath); // save right away so a crash can't create it twice
                Log.Info($"Created call {call.CallNumber} from incident {incident.Number}");
            }
            catch (Exception ex)
            {
                Log.Error($"Could not create a call for incident {incident.Number}: {ex.Message}");
                failures++;
            }
        }
        return failures;
    }

    // ---------- 2. e-automate call -> new ServiceNow incident ----------
    private static async Task<int> CreateIncidentsFromCallsAsync(
        List<ServiceCall> calls, ServiceNowClient snow, string groupId, Settings settings, SyncState state, string statePath)
    {
        int failures = 0;
        // PRODUCTION NOTE: every open call the API key can see becomes an incident. If the key covers
        // several customers or locations, filter here (e.g. by customerId or call type) so only the calls
        // meant for this ServiceNow instance are sent.
        foreach (var call in calls.Where(c => c.IsOpen))
        {
            if (state.FindByCall(call.CallId) != null)
                continue; // already linked (including calls this app created in step 1)

            string? serial = call.Equipment?.SerialNumber?.Trim();
            if (string.IsNullOrEmpty(serial))
            {
                Log.Warn($"Skipping call {call.CallNumber}: no equipment serial number");
                continue;
            }

            try
            {
                var ci = await snow.FindCiBySerialAsync(serial);
                if (ci == null)
                    Log.Warn($"Call {call.CallNumber}: no ServiceNow CI with serial {serial}; creating the incident without one");

                // PRODUCTION NOTE: values are sent as-is. ServiceNow's short_description holds 160 characters
                // by default, and the caller, category and other required fields of your instance are not set.
                var incident = await snow.CreateIncidentAsync(new Dictionary<string, string?>
                {
                    ["short_description"] = call.Description ?? $"Service call {call.CallNumber}",
                    ["description"] = $"e-automate service call {call.CallNumber}\n\n{call.Notes}",
                    ["cmdb_ci"] = ci?.SysId,
                    ["assignment_group"] = groupId,
                    ["urgency"] = settings.ServiceNow.Urgency,
                    ["impact"] = settings.ServiceNow.Impact,
                });

                state.Links.Add(new SyncLink
                {
                    CallId = call.CallId,
                    CallNumber = call.CallNumber,
                    IncidentSysId = incident.SysId,
                    IncidentNumber = incident.Number ?? "",
                    Direction = "FromEautomate",
                });
                state.Save(statePath);
                Log.Info($"Created incident {incident.Number} from call {call.CallNumber}");
            }
            catch (Exception ex)
            {
                Log.Error($"Could not create an incident for call {call.CallNumber}: {ex.Message}");
                failures++;
            }
        }
        return failures;
    }

    // ---------- 3. completed e-automate call -> close the ServiceNow incident ----------
    private static async Task<int> CloseCompletedIncidentsAsync(
        List<ServiceCall> calls, ServiceNowClient snow, Settings settings, SyncState state, string statePath)
    {
        var completedStatuses = settings.Id136.CompletedStatuses
            .Select(s => s.Trim().ToUpperInvariant())
            .ToHashSet();

        int failures = 0;
        foreach (var call in calls)
        {
            var link = state.FindByCall(call.CallId);
            if (link == null || link.Completed)
                continue;

            string status = call.Status?.Trim().ToUpperInvariant() ?? "";
            if (!completedStatuses.Contains(status))
                continue;

            try
            {
                // PRODUCTION NOTE: the e-automate call notes become the incident's close notes, which
                // ServiceNow users can read. If your notes can hold internal or sensitive text, filter them
                // or use a fixed message instead.
                string notes = string.IsNullOrWhiteSpace(call.Notes)
                    ? $"Completed in e-automate as call {call.CallNumber}"
                    : call.Notes;
                await snow.CloseIncidentAsync(link.IncidentSysId, notes);

                link.Completed = true;
                state.Save(statePath);
                Log.Info($"Closed incident {link.IncidentNumber}: call {call.CallNumber} is {status}");
            }
            catch (Exception ex)
            {
                Log.Error($"Could not close incident {link.IncidentNumber} for call {call.CallNumber}: {ex.Message}");
                failures++;
            }
        }
        return failures;
    }

    // appsettings.json, then appsettings.local.json (optional, not committed) for real secrets.
    // PRODUCTION NOTE: secrets in a plain JSON file are readable by anyone who can read the folder.
    // Load them from a secret store instead (environment variables via AddEnvironmentVariables(),
    // Windows DPAPI / Credential Manager, Azure Key Vault, AWS Secrets Manager, ...), and never commit them.
    private static Settings LoadSettings()
    {
        var config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .AddJsonFile("appsettings.local.json", optional: true)
            .Build();
        return config.Get<Settings>() ?? new Settings();
    }
}
