using System.Text.Json;

namespace PublicSnowSyncClient;

// Everything the app remembers between runs, kept in a JSON file (no database needed).
//
// PRODUCTION NOTE: a local JSON file is the simplest possible store, with real limits:
//   - It lives on one machine. Lose it (new server, restore, cleanup) and the next run treats every
//     open call as new and creates duplicate incidents. Back it up, or keep the links in a database.
//   - There is no locking, so two overlapping runs can overwrite each other's changes.
//   - It never shrinks; completed links are kept forever. Prune old completed links if it gets large.
// A small database table with a unique key on CallId and on IncidentSysId solves all three.
public class SyncState
{
    // Newest e-automate "lastUpdate" seen so far. The next run asks ID136 for calls
    // changed since then. It comes from the e-automate server's own clock, so time
    // zones don't matter.
    public DateTime? LastCallUpdateSeen { get; set; }

    // One entry per e-automate call that is paired with a ServiceNow incident.
    public List<SyncLink> Links { get; set; } = [];

    public SyncLink? FindByCall(int callId) => Links.FirstOrDefault(l => l.CallId == callId);
    public SyncLink? FindByIncident(string sysId) => Links.FirstOrDefault(l => l.IncidentSysId == sysId);

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static SyncState Load(string path)
    {
        if (!File.Exists(path))
            return new SyncState();
        return JsonSerializer.Deserialize<SyncState>(File.ReadAllText(path), JsonOptions) ?? new SyncState();
    }

    // Write to a temp file first, then replace, so a crash never leaves a half-written file.
    public void Save(string path)
    {
        string tempPath = path + ".tmp";
        File.WriteAllText(tempPath, JsonSerializer.Serialize(this, JsonOptions));
        File.Move(tempPath, path, overwrite: true);
    }
}

public class SyncLink
{
    public int CallId { get; set; }
    public string CallNumber { get; set; } = "";
    public string IncidentSysId { get; set; } = "";
    public string IncidentNumber { get; set; } = "";

    // "FromServiceNow" (incident created the call) or "FromEautomate" (call created the incident).
    public string Direction { get; set; } = "";

    // True once the incident has been closed because the call was completed.
    public bool Completed { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;
}
