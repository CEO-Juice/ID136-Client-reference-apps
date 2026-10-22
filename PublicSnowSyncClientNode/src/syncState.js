import fs from 'node:fs';

// Everything the app remembers between runs, kept in a JSON file (no database needed).
//
// {
//   "LastCallUpdateSeen": "2026-10-21T11:06:00",   // newest e-automate lastUpdate seen
//   "Links": [ { CallId, CallNumber, IncidentSysId, IncidentNumber, Direction, Completed, CreatedAt } ]
// }
//
// Same format as the .NET PublicSnowSyncClient, so either app can pick up the other's file.
//
// PRODUCTION NOTE: a local JSON file is the simplest possible store, with real limits:
//   - It lives on one machine. Lose it (new server, restore, cleanup) and the next run treats every
//     open call as new and creates duplicate incidents. Back it up, or keep the links in a database.
//   - There is no locking, so two overlapping runs can overwrite each other's changes.
//   - It never shrinks; completed links are kept forever. Prune old completed links if it gets large.
// A small database table with a unique key on CallId and on IncidentSysId solves all three.
export class SyncState {
  constructor(data = {}) {
    // Newest e-automate "lastUpdate" seen so far. The next run asks ID136 for calls changed
    // since then. It comes from the e-automate server's own clock, so time zones don't matter.
    this.LastCallUpdateSeen = data.LastCallUpdateSeen ?? null;

    // One entry per e-automate call that is paired with a ServiceNow incident.
    this.Links = data.Links ?? [];
  }

  findByCall(callId) {
    return this.Links.find((link) => link.CallId === callId);
  }

  findByIncident(sysId) {
    return this.Links.find((link) => link.IncidentSysId === sysId);
  }

  static load(file) {
    if (!fs.existsSync(file)) return new SyncState();
    return new SyncState(JSON.parse(fs.readFileSync(file, 'utf8')));
  }

  // Write to a temp file first, then replace, so a crash never leaves a half-written file.
  save(file) {
    const tempFile = `${file}.tmp`;
    const data = { LastCallUpdateSeen: this.LastCallUpdateSeen, Links: this.Links };
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, file);
  }
}

// e-automate times have no time zone ("2026-10-21T11:06:00"). Keep them as text and do the
// arithmetic as if they were UTC, so the time zone of the machine running this never shifts them.
export function eautoTimeMinusMinutes(eautoTime, minutes) {
  const time = new Date(eautoTime.slice(0, 19) + 'Z');
  time.setUTCMinutes(time.getUTCMinutes() - minutes);
  return time.toISOString().slice(0, 19);
}

// Same fixed-width format, so plain text comparison orders them correctly.
export function newestEautoTime(times) {
  return times.map((t) => t.slice(0, 19)).sort().at(-1) ?? null;
}
