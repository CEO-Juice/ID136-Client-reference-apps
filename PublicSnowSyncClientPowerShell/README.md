# PublicSnowSyncClientPowerShell

A small reference integration between **e-automate** and **ServiceNow**, written in PowerShell. It does the same thing as the .NET [PublicSnowSyncClient](../PublicSnowSyncClient/README.md) and the Node.js [PublicSnowSyncClientNode](../PublicSnowSyncClientNode/README.md) versions, and the ServiceNow-native [PublicSnowSyncClientServiceNow](../PublicSnowSyncClientServiceNow/README.md); use whichever language suits you as a starting point for your own integration.

A Python version is in [PublicSnowSyncClientPython](../PublicSnowSyncClientPython/README.md).

> **Not production-ready as is.** Several parts are simplified to keep the code easy to read. See [Before using this in production](#before-using-this-in-production); the same points are marked `PRODUCTION NOTE:` in the code.

> **Not yet run.** Unlike the .NET and Node.js versions, this script has not been executed or tested yet, in either Windows PowerShell 5.1 or PowerShell 7. Expect to fix small issues on first use, and please report them.

It runs in **Windows PowerShell 5.1** (built into Windows) and **PowerShell 7+**, with no modules to install. It only talks to two web APIs:

- the **ID136 Client Services API** (from your e-automate dealer), to read and create service calls
- the **ServiceNow Table API**, to read, create and close incidents

It needs no database. What it has already synced is kept in a JSON file.

## What one run does

Each run does one pass and exits. Schedule it every 5–15 minutes.

1. **ServiceNow → e-automate.** Reads the active incidents in your assignment group. For each new incident with a linked configuration item (CI), it creates an e-automate service call. The equipment, and so the customer, is found by the CI's serial number.
2. **e-automate → ServiceNow.** Reads service calls from ID136. For each new open call, it creates an incident in your assignment group, linked to the CI with the same serial number.
3. **Completions.** When a linked call reaches a completed status in e-automate, it closes the incident with the call's notes as the close notes.

Nothing else is synced: later edits, notes and status changes other than completion stay in the system where they were made.

## Code layout

| File | What it does |
|---|---|
| `Sync-ServiceCalls.ps1` | The three steps above, in order. This is the script you run |
| `lib/Id136.ps1` | ID136 API: read calls (paged), create a call |
| `lib/ServiceNow.ps1` | ServiceNow API: sign in, read incidents (paged), find a CI, create and close incidents |
| `lib/Settings.ps1` | Loads `appsettings.json` and `appsettings.local.json`, checks required settings |
| `lib/SyncState.ps1` | Reads and writes the state file |
| `lib/Http.ps1` | Sends requests and reports HTTP errors with their response body |
| `lib/Log.ps1` | Console logging |

## Prerequisites

**Windows PowerShell 5.1 or PowerShell 7+.** On Windows, 5.1 is already installed. PowerShell 7 also runs on Linux and macOS.

**ID136 API key** (ask your dealer):
- The key must be allowed to read and create service calls (`AllowReadServiceCalls` and `AllowUpdateServiceCalls`).
- It must be scoped to your customer account(s); you only see and create calls for those customers.

**ServiceNow:**
- An OAuth application (client id and secret) with the password grant enabled.
- An integration user that can read `incident`, `cmdb_ci` and `sys_user_group`, and create and update incidents.

**Data:** the serial numbers on your ServiceNow CIs must match the equipment serial numbers in e-automate.

## Configuration

Settings live in `appsettings.json`. Put real secrets in `appsettings.local.json` next to it (same layout, only the values you want to override). That file is not committed.

| Setting | Meaning |
|---|---|
| `Id136.BaseUrl` | ID136 API address, e.g. `https://api.ceojuice.com/` |
| `Id136.ApiKey` | Your ID136 API key |
| `Id136.CallType` | e-automate call type code for calls created from incidents (optional) |
| `Id136.CompletedStatuses` | e-automate statuses that close the incident. Default `OKB, I, CMP, C` |
| `ServiceNow.BaseUrl` | Your instance, e.g. `https://yourinstance.service-now.com/` |
| `ServiceNow.ClientId` / `ClientSecret` | OAuth application credentials |
| `ServiceNow.Username` / `Password` | Integration user |
| `ServiceNow.AssignmentGroup` | Group name. Its incidents are synced, and new incidents are assigned to it |
| `ServiceNow.ExcludedStates` | Incident states not synced. Default `6` (Resolved) |
| `ServiceNow.Urgency` / `Impact` | Values for new incidents. Defaults `3` / `2` |
| `ServiceNow.ClosedState` / `CloseCode` | Values used to close an incident. Defaults `6` / `Solved (Permanently)` |
| `StateFile` | State file name, in this folder. Default `sync-state.json` |

## Running

```powershell
cd PublicSnowSyncClientPowerShell
.\Sync-ServiceCalls.ps1
```

If scripts are blocked on the machine, run it with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Sync-ServiceCalls.ps1`, or sign the script.

**Windows Task Scheduler:** create a task that runs every 5–15 minutes with

- Program: `powershell.exe` (or `pwsh.exe` for PowerShell 7)
- Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\Path\To\PublicSnowSyncClientPowerShell\Sync-ServiceCalls.ps1" *>> "C:\Path\To\sync.log"`
- Settings: "If the task is already running: **Do not start a new instance**"

The exit code is `0` when everything synced and `1` if anything failed; failed items are retried on the next run. Output goes to the console; the `*>>` above appends it to a log file.

## The state file

`sync-state.json` pairs each e-automate call with its incident. It uses the same format as the .NET and Node.js versions, so you can switch between them without losing track.

```json
{
  "LastCallUpdateSeen": "2026-10-21T14:05:12",
  "Links": [
    {
      "CallId": 123456,
      "CallNumber": "SC123456",
      "IncidentSysId": "9d385017c611228701d22104cc95c371",
      "IncidentNumber": "INC0010023",
      "Direction": "FromServiceNow",
      "Completed": false,
      "CreatedAt": "2026-10-21T18:05:30.000Z"
    }
  ]
}
```

- A call or incident that is already in `Links` is never created again.
- `LastCallUpdateSeen` is the newest change time ID136 has returned. The next run asks for calls changed since then (minus 15 minutes). It comes from the e-automate server's clock, so time zones don't matter. If it is empty, the run reads all open calls instead.
- Deleting the file makes the next run treat everything as new. ID136 won't create a second call for the same incident number, but incidents for open calls would be created again.

## Before using this in production

This is a reference app: it shows how the APIs fit together and leaves out what a production service needs. Each item below is also marked `PRODUCTION NOTE:` in the code, where the change would go.

- **Secrets.** `appsettings.local.json` is a plain file. Load secrets from a secret store (the SecretManagement module with Windows Credential Manager, DPAPI-encrypted files, Azure Key Vault, ...) and never commit them.
- **ServiceNow sign-in.** The password grant needs the integration user's password, and the token is never refreshed. Prefer an auth method without a stored user password if your instance allows it, refresh the token before it expires, and give the integration user only the roles it needs.
- **HTTPS.** Settings aren't checked for `https`. Make sure both base URLs use it.
- **One run at a time.** Nothing stops two runs from overlapping, which can create duplicates. Use a lock, or set Task Scheduler to "Do not start a new instance" while one is running.
- **State storage.** The JSON state file lives on one machine, has no locking and never shrinks. If it is lost, open calls get new incidents. Back it up, or use a database table with unique keys on the call id and the incident sys_id.
- **Retries.** Timeouts, rate limits (HTTP 429) and server errors (5xx) aren't retried within a run. Add retries with backoff that respect `Retry-After`.
- **Items that always fail.** One call that can never sync holds the watermark back for good. Park items after repeated failures in a list someone reviews.
- **Logging and alerting.** Output goes to the console only. Use a logging library with rotating files, alert on failures, and never log secrets.
- **Data mapping.** Fields are copied as-is: nothing is shortened to fit, and your instance's other required incident fields aren't set. The e-automate call notes become the incident's close notes, which ServiceNow users can read.
- **Which calls are sent.** Every open call the API key can see becomes an incident. Filter by customer or call type if the key covers more than this ServiceNow instance should get.
- **Scale.** Every active incident in the group is read on every run. For a busy group, filter on `sys_updated_on` too.

## Limitations

- Incidents without a CI, or whose CI has no serial number, are skipped (logged as warnings).
- If the API key covers more than one customer, every one of their open calls becomes an incident.
- Reschedules and cancellations are not synced; only completions are.
- ID136 matches a new call to an existing one by incident number. If a call already exists for that incident number, even a closed one, ID136 returns it instead of creating a new call.
