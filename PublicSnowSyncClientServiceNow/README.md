# PublicSnowSyncClientServiceNow

A small reference integration between **e-automate** and **ServiceNow** that runs **inside ServiceNow**. It does the same thing as the [.NET](../PublicSnowSyncClient/README.md), [Node.js](../PublicSnowSyncClientNode/README.md) and [PowerShell](../PublicSnowSyncClientPowerShell/README.md) versions. The difference is that there's no server to run, no scheduler to set up, and no ServiceNow credentials to store outside ServiceNow.

A Python version is in [PublicSnowSyncClientPython](../PublicSnowSyncClientPython/README.md).

> **Not production-ready as is.** Several parts are simplified to keep the code easy to read. See [Before using this in production](#before-using-this-in-production); the same points are marked `PRODUCTION NOTE:` in the code.

> **Not yet run.** Unlike the .NET and Node.js versions, these scripts have not been executed or tested on a ServiceNow instance yet. Try them on a sub-production or Personal Developer Instance first, expect to fix small issues on first use, and please report them.

It calls one web API, the **ID136 Client Services API** (from your e-automate dealer), to read and create service calls. Everything on the ServiceNow side uses normal records, so there is no state file.

## What one run does

A scheduled job runs it every 5–15 minutes.

1. **ServiceNow → e-automate.** Finds active incidents in your assignment group that aren't linked yet and have a configuration item (CI) with a serial number. For each, it creates an e-automate service call. The equipment, and so the customer, is found by the CI's serial number.
2. **e-automate → ServiceNow.** Reads service calls from ID136. For each new open call, it creates an incident in your assignment group, linked to the CI with the same serial number.
3. **Completions.** When a linked call reaches a completed status in e-automate, it closes the incident with the call's notes as the close notes.

Nothing else is synced: later edits, notes and status changes other than completion stay in the system where they were made.

## How the link is stored

Instead of a state file, each linked incident carries the link itself, in two standard fields meant for integrations:

| Field | Value |
|---|---|
| `correlation_id` | `EAUTO-` followed by the e-automate call id, e.g. `EAUTO-123456` |
| `correlation_display` | The e-automate call number, e.g. `SC123456` |

An incident with a `correlation_id` is never sent to e-automate, and a call with a linked incident never gets a second one. Incidents created from ServiceNow also get a work note naming the new call.

The only other state is the watermark, in the system property `eautomate.sync.last_call_update_seen`: the newest change time ID136 has returned. Each run asks for calls changed since then, minus 15 minutes. It comes from the e-automate server's clock, so time zones don't matter. If it is empty, the run reads all open calls instead.

## Files

| File | Where it goes in ServiceNow |
|---|---|
| `script-include/EautomateSync.js` | A Script Include named `EautomateSync`. All of the sync logic |
| `scheduled-job/run-sync.js` | The script of a Scheduled Script Execution that runs the sync |
| `setup/create-properties.js` | Run once in Scripts - Background to create the settings |

## Prerequisites

**ID136 API key** (ask your dealer):
- The key must be allowed to read and create service calls (`AllowReadServiceCalls` and `AllowUpdateServiceCalls`).
- It must be scoped to your customer account(s); you only see and create calls for those customers.

**ServiceNow:**
- An admin to install it, and outbound HTTPS from the instance to the ID136 API address.
- A dedicated integration user for the scheduled job to run as, with rights to read and write incidents and read CIs and groups.

**Data:** the serial numbers on your CIs must match the equipment serial numbers in e-automate.

## Installing

1. **Store the API key.** Go to **Connections & Credentials > Credentials**, click **New**, and choose **API Key Credentials**. Give it a name (e.g. "e-automate ID136") and paste the key into **API Key**. Save it, then copy its sys_id (right-click the header > **Copy sys_id**).
2. **Create the settings.** Open `setup/create-properties.js` and fill in at least the assignment group name and the credential sys_id from step 1. Paste it into **System Definition > Scripts - Background** and run it. You can change the values later under **System Properties** (search for `eautomate.sync`).
3. **Add the script include.** Go to **System Definition > Script Includes > New**. Set **Name** to `EautomateSync`, leave **Client callable** off, paste in `script-include/EautomateSync.js`, and save.
4. **Schedule it.** Go to **System Definition > Scheduled Jobs > New > Automatically run a script of your choosing**. Name it "e-automate sync", set **Run** to **Periodically** every 5–15 minutes, set **Run as** to your integration user, paste in `scheduled-job/run-sync.js`, and save.
5. **Try it.** Open the scheduled job and click **Execute Now**. Then check **System Logs > System Log > All**, filtered on **Source** = `EautomateSync`.

## Configuration

All settings are system properties starting with `eautomate.sync.`:

| Property | Meaning |
|---|---|
| `id136.base_url` | ID136 API address, e.g. `https://api.ceojuice.com/` |
| `id136.credential` | sys_id of the API Key credential that holds the ID136 API key |
| `id136.call_type` | e-automate call type code for calls created from incidents (optional) |
| `id136.completed_statuses` | e-automate statuses that close the incident. Default `OKB,I,CMP,C` |
| `assignment_group` | Group name. Its incidents are synced, and new incidents are assigned to it |
| `excluded_states` | Incident states not synced. Default `6` (Resolved) |
| `urgency` / `impact` | Values for new incidents. Defaults `3` / `2` |
| `closed_state` / `close_code` | Values used to close an incident. Defaults `6` / `Solved (Permanently)` |
| `last_call_update_seen` | Set by the sync (the watermark). Clear it to re-read all open calls |

The API key is never stored in a property, a script or the log. The script reads it from the credential record when it runs.

## Before using this in production

This is a reference script: it shows how the pieces fit together and leaves out what a production integration needs. Each item below is also marked `PRODUCTION NOTE:` in the code, where the change would go.

- **Scope and packaging.** It's pasted into the global scope by hand. Package it as a scoped application (or at least an update set) so it can be versioned, reviewed and moved between instances, and so its access is limited to what it needs.
- **Integration user.** Run the job as a dedicated user with only the roles it needs, not as an admin.
- **Overlapping runs.** If a run takes longer than the interval, the next one can start and create duplicates. Keep the interval longer than a run, or add a lock.
- **Retries.** Timeouts, rate limits (HTTP 429) and server errors (5xx) aren't retried within a run. Add retries with backoff, or move the ID136 calls into Flow Designer actions with retry settings. If ID136 is only reachable from your network, route the calls through a MID Server.
- **Items that always fail.** One call that can never sync holds the watermark back for good. Park items after repeated failures in a list someone reviews.
- **Alerting.** Failures only go to the system log. Raise an event, create a task, or feed your monitoring.
- **Data mapping.** Fields are copied as-is: nothing is shortened to fit, and your instance's other required incident fields aren't set. The e-automate call notes become the incident's close notes, which ServiceNow users can read.
- **Which records are sent.** Every open call the API key can see becomes an incident; filter by customer or call type if needed. Active incidents without a CI serial number are skipped without a warning.
- **Correlation fields.** Incidents already linked to another integration through `correlation_id` are never sent to e-automate. If you use those fields for something else, store the link in a custom field instead.

## Limitations

- Incidents without a CI, or whose CI has no serial number, are skipped.
- If the API key covers more than one customer, every one of their open calls becomes an incident.
- Reschedules and cancellations are not synced; only completions are.
- ID136 matches a new call to an existing one by incident number. If a call already exists for that incident number, even a closed one, ID136 returns it instead of creating a new call.
- The script uses the global scope and ES5 JavaScript so it works on any release. The API Key credential type and `sn_cc.StandardCredentialsProvider` need a release that has Connections & Credentials (Orlando or later).
