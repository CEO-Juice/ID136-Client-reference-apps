"""Everything the app remembers between runs, kept in a JSON file (no database needed).

    {
      "LastCallUpdateSeen": "2026-10-21T11:06:00",   # newest e-automate lastUpdate seen
      "Links": [ { CallId, CallNumber, IncidentSysId, IncidentNumber, Direction, Completed, CreatedAt } ]
    }

Same format as the .NET, Node.js and PowerShell versions, so any of them can pick up the others' file.

PRODUCTION NOTE: a local JSON file is the simplest possible store, with real limits:
  - It lives on one machine. Lose it (new server, restore, cleanup) and the next run treats every
    open call as new and creates duplicate incidents. Back it up, or keep the links in a database.
  - There is no locking, so two overlapping runs can overwrite each other's changes.
  - It never shrinks; completed links are kept forever. Prune old completed links if it gets large.
A small database table with a unique key on CallId and on IncidentSysId solves all three.
"""
import json
import os
from datetime import datetime, timedelta

EAUTO_TIME_FORMAT = "%Y-%m-%dT%H:%M:%S"


class SyncState:
    def __init__(self, data=None):
        data = data or {}
        # Newest e-automate "lastUpdate" seen so far. The next run asks ID136 for calls changed
        # since then. It comes from the e-automate server's own clock, so time zones don't matter.
        self.last_call_update_seen = data.get("LastCallUpdateSeen")
        # One entry per e-automate call that is paired with a ServiceNow incident.
        self.links = data.get("Links") or []

    def find_by_call(self, call_id):
        return next((link for link in self.links if link["CallId"] == call_id), None)

    def find_by_incident(self, sys_id):
        return next((link for link in self.links if link["IncidentSysId"] == sys_id), None)

    @classmethod
    def load(cls, path):
        if not os.path.exists(path):
            return cls()
        # utf-8-sig also accepts a file written with a byte-order mark (e.g. by another tool).
        with open(path, encoding="utf-8-sig") as f:
            return cls(json.load(f))

    def save(self, path):
        """Write to a temp file first, then replace, so a crash never leaves a half-written file."""
        temp_path = path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump({"LastCallUpdateSeen": self.last_call_update_seen, "Links": self.links}, f, indent=2)
        os.replace(temp_path, path)


def eauto_time(value):
    """e-automate times have no time zone ("2026-10-21T11:06:00"). Keep them as text in that fixed
    format so the time zone of the machine running this never shifts them."""
    return str(value or "")[:19]


def eauto_time_minus_minutes(value, minutes):
    # A "naive" datetime (no time zone) is plain clock arithmetic, so nothing gets shifted.
    time = datetime.strptime(eauto_time(value), EAUTO_TIME_FORMAT)
    return (time - timedelta(minutes=minutes)).strftime(EAUTO_TIME_FORMAT)
