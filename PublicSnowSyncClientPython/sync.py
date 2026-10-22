"""Reference integration between e-automate (through the ID136 API) and ServiceNow.
Each run does one pass and exits; schedule it every few minutes.

  1. ServiceNow -> e-automate: new incidents in the assignment group become service calls.
  2. e-automate -> ServiceNow: new open service calls become incidents.
  3. e-automate -> ServiceNow: completed calls close their incident.

Which call belongs to which incident is remembered in a JSON state file.
Run with:  python3 sync.py      Exit code 0 = everything synced, 1 = something failed.

THIS IS A REFERENCE APP, NOT A PRODUCTION SERVICE. It is kept short so it is easy to read.
Places where it takes a shortcut you should not ship are marked "PRODUCTION NOTE:"
(search for that text). The README has the same list under "Before using this in production".
"""
import os
import sys
from datetime import datetime

import log
from id136_client import Id136Client
from servicenow_client import ServiceNowClient
from settings import find_missing_settings, load_settings
from sync_state import SyncState, eauto_time, eauto_time_minus_minutes

# Re-read this much before the watermark each run, in case of late-arriving changes.
# Anything already handled is skipped because it is in the state file.
WATERMARK_OVERLAP_MINUTES = 15

OPEN_STATUSES = {"P", "D", "A", "H"}


def main():
    app_dir = os.path.dirname(os.path.abspath(__file__))
    settings = load_settings(app_dir)
    missing = find_missing_settings(settings)
    if missing:
        log.error("Missing settings in appsettings.json: " + ", ".join(missing))
        return 1

    # PRODUCTION NOTE: nothing stops two runs from overlapping (e.g. a slow run when the scheduler
    # starts the next one). Both would read the same state file and could create the same call or
    # incident twice. Use a lock (a lock file, or "do not start a new instance" in the scheduler)
    # so only one run happens at a time.
    state_path = os.path.join(app_dir, settings["StateFile"])
    state = SyncState.load(state_path)

    id136 = Id136Client(settings["Id136"])
    snow = ServiceNowClient(settings["ServiceNow"])

    try:
        snow.connect()
        group_name = settings["ServiceNow"]["AssignmentGroup"]
        group_id = snow.get_group_id(group_name)
        if not group_id:
            raise RuntimeError(f"Assignment group '{group_name}' not found in ServiceNow")

        failures = 0

        # 1. ServiceNow -> e-automate
        incidents = snow.get_active_incidents(group_id, settings["ServiceNow"]["ExcludedStates"])
        log.info(f"{len(incidents)} active incidents in '{group_name}'")
        failures += create_calls_from_incidents(incidents, id136, settings, state, state_path)

        # 2 and 3 use the same list of calls from ID136.
        changed_since = None
        if state.last_call_update_seen:
            changed_since = eauto_time_minus_minutes(state.last_call_update_seen, WATERMARK_OVERLAP_MINUTES)
        calls = id136.get_calls(changed_since)
        if changed_since:
            log.info(f"{len(calls)} calls changed in e-automate since {changed_since}")
        else:
            log.info(f"{len(calls)} open calls in e-automate (first run)")

        failures += create_incidents_from_calls(calls, snow, group_id, settings, state, state_path)
        failures += close_completed_incidents(calls, snow, settings, state, state_path)

        # Only move the watermark forward when everything worked, so failed calls are read again next run.
        # PRODUCTION NOTE: one call that can never succeed (e.g. bad data) holds the watermark back for
        # good, so every run re-reads an ever-growing window. Track repeated failures per call, park them
        # after a few attempts (a "dead letter" list someone reviews), and let the watermark move on.
        if failures == 0 and calls:
            # Same fixed-width text format, so plain comparison orders them correctly.
            newest = max(eauto_time(call.get("lastUpdate")) for call in calls)
            if not state.last_call_update_seen or newest > state.last_call_update_seen:
                state.last_call_update_seen = newest
        state.save(state_path)

        if failures == 0:
            log.info("Sync finished")
            return 0
        log.info(f"Sync finished with {failures} failure(s); they will be retried next run")
        return 1
    except Exception as e:
        # PRODUCTION NOTE: failures only show up in the console output and the exit code.
        # Send them somewhere someone will see (alerting, monitoring, email).
        log.error(f"Sync stopped: {e}")
        return 1


# ---------- 1. ServiceNow incident -> new e-automate call ----------
def create_calls_from_incidents(incidents, id136, settings, state, state_path):
    failures = 0
    for incident in incidents:
        if state.find_by_incident(incident["sys_id"]):
            continue  # already linked

        # e-automate finds the equipment (and so the customer) by serial number.
        serial = incident.get("cmdb_ci.serial_number")
        if not serial:
            log.warn(f"Skipping {incident['number']}: no configuration item with a serial number")
            continue

        try:
            # PRODUCTION NOTE: the field mapping is minimal and nothing is shortened or cleaned up.
            # e-automate limits the description (about 210 characters after the reference prefix) and
            # the caller field; map the fields your process needs and trim them to fit.
            # Also, if a call already exists for this incident number (even a closed one), ID136
            # returns that call instead of creating a new one; check its status if that matters to you.
            call = id136.add_call(
                description=incident.get("short_description") or incident["number"],
                notes=incident.get("description"),
                serial_number=serial,
                contact=f"{incident.get('caller_id.name') or ''} {incident.get('caller_id.email') or ''}".strip(),
                call_type=settings["Id136"].get("CallType"),
                reference_call_identifier=incident["number"],
            )

            state.links.append(new_link(call, incident["sys_id"], incident["number"], "FromServiceNow"))
            state.save(state_path)  # save right away so a crash can't create it twice
            log.info(f"Created call {call['callNumber']} from incident {incident['number']}")
        except Exception as e:
            log.error(f"Could not create a call for incident {incident['number']}: {e}")
            failures += 1
    return failures


# ---------- 2. e-automate call -> new ServiceNow incident ----------
def create_incidents_from_calls(calls, snow, group_id, settings, state, state_path):
    failures = 0
    # PRODUCTION NOTE: every open call the API key can see becomes an incident. If the key covers
    # several customers or locations, filter here (e.g. by customerId or call type) so only the calls
    # meant for this ServiceNow instance are sent.
    open_calls = [call for call in calls if normalize_status(call.get("status")) in OPEN_STATUSES]

    for call in open_calls:
        if state.find_by_call(call["callId"]):
            continue  # already linked (including calls created in step 1)

        serial = ((call.get("equipment") or {}).get("serialNumber") or "").strip()
        if not serial:
            log.warn(f"Skipping call {call['callNumber']}: no equipment serial number")
            continue

        try:
            ci = snow.find_ci_by_serial(serial)
            if not ci:
                log.warn(f"Call {call['callNumber']}: no ServiceNow CI with serial {serial}; creating the incident without one")

            # PRODUCTION NOTE: values are sent as-is. ServiceNow's short_description holds 160 characters
            # by default, and the caller, category and other required fields of your instance are not set.
            incident = snow.create_incident({
                "short_description": call.get("description") or f"Service call {call['callNumber']}",
                "description": f"e-automate service call {call['callNumber']}\n\n{call.get('notes') or ''}",
                "cmdb_ci": ci["sys_id"] if ci else None,
                "assignment_group": group_id,
                "urgency": settings["ServiceNow"]["Urgency"],
                "impact": settings["ServiceNow"]["Impact"],
            })

            state.links.append(new_link(call, incident["sys_id"], incident.get("number") or "", "FromEautomate"))
            state.save(state_path)
            log.info(f"Created incident {incident.get('number')} from call {call['callNumber']}")
        except Exception as e:
            log.error(f"Could not create an incident for call {call['callNumber']}: {e}")
            failures += 1
    return failures


# ---------- 3. completed e-automate call -> close the ServiceNow incident ----------
def close_completed_incidents(calls, snow, settings, state, state_path):
    completed_statuses = {normalize_status(s) for s in settings["Id136"]["CompletedStatuses"]}
    failures = 0

    for call in calls:
        link = state.find_by_call(call["callId"])
        if not link or link["Completed"]:
            continue

        status = normalize_status(call.get("status"))
        if status not in completed_statuses:
            continue

        try:
            # PRODUCTION NOTE: the e-automate call notes become the incident's close notes, which
            # ServiceNow users can read. If your notes can hold internal or sensitive text, filter them
            # or use a fixed message instead.
            notes = call.get("notes") if (call.get("notes") or "").strip() else f"Completed in e-automate as call {call['callNumber']}"
            snow.close_incident(link["IncidentSysId"], notes)

            link["Completed"] = True
            state.save(state_path)
            log.info(f"Closed incident {link['IncidentNumber']}: call {call['callNumber']} is {status}")
        except Exception as e:
            log.error(f"Could not close incident {link['IncidentNumber']} for call {call['callNumber']}: {e}")
            failures += 1
    return failures


def new_link(call, incident_sys_id, incident_number, direction):
    return {
        "CallId": call["callId"],
        "CallNumber": call["callNumber"],
        "IncidentSysId": incident_sys_id,
        "IncidentNumber": incident_number,
        "Direction": direction,
        "Completed": False,
        "CreatedAt": datetime.now().astimezone().isoformat(),
    }


def normalize_status(status):
    """e-automate pads status codes with spaces ("I "), so compare them trimmed."""
    return (status or "").strip().upper()


if __name__ == "__main__":
    sys.exit(main())
