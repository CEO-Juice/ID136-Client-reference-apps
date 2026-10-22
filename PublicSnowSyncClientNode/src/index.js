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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import { loadSettings, findMissingSettings } from './settings.js';
import { SyncState, eautoTimeMinusMinutes, newestEautoTime } from './syncState.js';
import { Id136Client } from './id136Client.js';
import { ServiceNowClient } from './serviceNowClient.js';

// Re-read this much before the watermark each run, in case of late-arriving changes.
// Anything already handled is skipped because it is in the state file.
const WATERMARK_OVERLAP_MINUTES = 15;

const OPEN_STATUSES = ['P', 'D', 'A', 'H'];

async function main() {
  const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const settings = loadSettings(appDir);
  const missing = findMissingSettings(settings);
  if (missing.length > 0) {
    log.error(`Missing settings in appsettings.json: ${missing.join(', ')}`);
    return 1;
  }

  // PRODUCTION NOTE: nothing stops two runs from overlapping (e.g. a slow run when the scheduler
  // starts the next one). Both would read the same state file and could create the same call or
  // incident twice. Use a lock (a lock file, or "do not start a new instance" in the scheduler)
  // so only one run happens at a time.
  const statePath = path.join(appDir, settings.StateFile);
  const state = SyncState.load(statePath);

  const id136 = new Id136Client(settings.Id136);
  const snow = new ServiceNowClient(settings.ServiceNow);

  try {
    await snow.connect();
    const groupId = await snow.getGroupId(settings.ServiceNow.AssignmentGroup);
    if (!groupId) {
      throw new Error(`Assignment group '${settings.ServiceNow.AssignmentGroup}' not found in ServiceNow`);
    }

    let failures = 0;

    // 1. ServiceNow -> e-automate
    const incidents = await snow.getActiveIncidents(groupId, settings.ServiceNow.ExcludedStates);
    log.info(`${incidents.length} active incidents in '${settings.ServiceNow.AssignmentGroup}'`);
    failures += await createCallsFromIncidents(incidents, id136, settings, state, statePath);

    // 2 and 3 use the same list of calls from ID136.
    const changedSince = state.LastCallUpdateSeen
      ? eautoTimeMinusMinutes(state.LastCallUpdateSeen, WATERMARK_OVERLAP_MINUTES)
      : null;
    const calls = await id136.getCalls(changedSince);
    log.info(changedSince
      ? `${calls.length} calls changed in e-automate since ${changedSince}`
      : `${calls.length} open calls in e-automate (first run)`);

    failures += await createIncidentsFromCalls(calls, snow, groupId, settings, state, statePath);
    failures += await closeCompletedIncidents(calls, snow, settings, state, statePath);

    // Only move the watermark forward when everything worked, so failed calls are read again next run.
    // PRODUCTION NOTE: one call that can never succeed (e.g. bad data) holds the watermark back for
    // good, so every run re-reads an ever-growing window. Track repeated failures per call, park them
    // after a few attempts (a "dead letter" list someone reviews), and let the watermark move on.
    if (failures === 0 && calls.length > 0) {
      const newest = newestEautoTime(calls.map((call) => call.lastUpdate));
      if (!state.LastCallUpdateSeen || newest > state.LastCallUpdateSeen) {
        state.LastCallUpdateSeen = newest;
      }
    }
    state.save(statePath);

    log.info(failures === 0 ? 'Sync finished' : `Sync finished with ${failures} failure(s); they will be retried next run`);
    return failures === 0 ? 0 : 1;
  } catch (error) {
    // PRODUCTION NOTE: failures only show up in the console output and the exit code.
    // Send them somewhere someone will see (alerting, monitoring, email).
    log.error(`Sync stopped: ${error.message}`);
    return 1;
  }
}

// ---------- 1. ServiceNow incident -> new e-automate call ----------
async function createCallsFromIncidents(incidents, id136, settings, state, statePath) {
  let failures = 0;
  for (const incident of incidents) {
    if (state.findByIncident(incident.sys_id)) continue; // already linked

    // e-automate finds the equipment (and so the customer) by serial number.
    const serial = incident['cmdb_ci.serial_number'];
    if (!serial) {
      log.warn(`Skipping ${incident.number}: no configuration item with a serial number`);
      continue;
    }

    try {
      // PRODUCTION NOTE: the field mapping is minimal and nothing is shortened or cleaned up.
      // e-automate limits the description (about 210 characters after the reference prefix) and
      // the caller field; map the fields your process needs and trim them to fit.
      // Also, if a call already exists for this incident number (even a closed one), ID136
      // returns that call instead of creating a new one; check its status if that matters to you.
      const call = await id136.addCall({
        description: incident.short_description || incident.number,
        notes: incident.description,
        serialNumber: serial,
        contact: `${incident['caller_id.name'] ?? ''} ${incident['caller_id.email'] ?? ''}`.trim(),
        callType: settings.Id136.CallType || undefined,
        referenceCallIdentifier: incident.number,
      });

      state.Links.push({
        CallId: call.callId,
        CallNumber: call.callNumber,
        IncidentSysId: incident.sys_id,
        IncidentNumber: incident.number,
        Direction: 'FromServiceNow',
        Completed: false,
        CreatedAt: new Date().toISOString(),
      });
      state.save(statePath); // save right away so a crash can't create it twice
      log.info(`Created call ${call.callNumber} from incident ${incident.number}`);
    } catch (error) {
      log.error(`Could not create a call for incident ${incident.number}: ${error.message}`);
      failures++;
    }
  }
  return failures;
}

// ---------- 2. e-automate call -> new ServiceNow incident ----------
async function createIncidentsFromCalls(calls, snow, groupId, settings, state, statePath) {
  let failures = 0;
  // PRODUCTION NOTE: every open call the API key can see becomes an incident. If the key covers
  // several customers or locations, filter here (e.g. by customerId or call type) so only the calls
  // meant for this ServiceNow instance are sent.
  const openCalls = calls.filter((call) => OPEN_STATUSES.includes(normalizeStatus(call.status)));

  for (const call of openCalls) {
    if (state.findByCall(call.callId)) continue; // already linked (including calls created in step 1)

    const serial = call.equipment?.serialNumber?.trim();
    if (!serial) {
      log.warn(`Skipping call ${call.callNumber}: no equipment serial number`);
      continue;
    }

    try {
      const ci = await snow.findCiBySerial(serial);
      if (!ci) {
        log.warn(`Call ${call.callNumber}: no ServiceNow CI with serial ${serial}; creating the incident without one`);
      }

      // PRODUCTION NOTE: values are sent as-is. ServiceNow's short_description holds 160 characters
      // by default, and the caller, category and other required fields of your instance are not set.
      const incident = await snow.createIncident({
        short_description: call.description || `Service call ${call.callNumber}`,
        description: `e-automate service call ${call.callNumber}\n\n${call.notes ?? ''}`,
        cmdb_ci: ci?.sys_id,
        assignment_group: groupId,
        urgency: settings.ServiceNow.Urgency,
        impact: settings.ServiceNow.Impact,
      });

      state.Links.push({
        CallId: call.callId,
        CallNumber: call.callNumber,
        IncidentSysId: incident.sys_id,
        IncidentNumber: incident.number ?? '',
        Direction: 'FromEautomate',
        Completed: false,
        CreatedAt: new Date().toISOString(),
      });
      state.save(statePath);
      log.info(`Created incident ${incident.number} from call ${call.callNumber}`);
    } catch (error) {
      log.error(`Could not create an incident for call ${call.callNumber}: ${error.message}`);
      failures++;
    }
  }
  return failures;
}

// ---------- 3. completed e-automate call -> close the ServiceNow incident ----------
async function closeCompletedIncidents(calls, snow, settings, state, statePath) {
  const completedStatuses = settings.Id136.CompletedStatuses.map(normalizeStatus);
  let failures = 0;

  for (const call of calls) {
    const link = state.findByCall(call.callId);
    if (!link || link.Completed) continue;

    const status = normalizeStatus(call.status);
    if (!completedStatuses.includes(status)) continue;

    try {
      // PRODUCTION NOTE: the e-automate call notes become the incident's close notes, which
      // ServiceNow users can read. If your notes can hold internal or sensitive text, filter them
      // or use a fixed message instead.
      const notes = call.notes?.trim() ? call.notes : `Completed in e-automate as call ${call.callNumber}`;
      await snow.closeIncident(link.IncidentSysId, notes);

      link.Completed = true;
      state.save(statePath);
      log.info(`Closed incident ${link.IncidentNumber}: call ${call.callNumber} is ${status}`);
    } catch (error) {
      log.error(`Could not close incident ${link.IncidentNumber} for call ${call.callNumber}: ${error.message}`);
      failures++;
    }
  }
  return failures;
}

// e-automate pads status codes with spaces ("I "), so compare them trimmed.
function normalizeStatus(status) {
  return (status ?? '').trim().toUpperCase();
}

process.exitCode = await main();
