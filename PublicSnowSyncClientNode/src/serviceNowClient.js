// Talks to the ServiceNow Table API (api/now/table/...). Authenticates once per run
// with the OAuth password grant and sends the token on every request.

const PAGE_SIZE = 500;
const TIMEOUT_MS = 60_000;

// "Dot-walked" fields (cmdb_ci.serial_number, caller_id.*) bring in values from the linked
// CI and caller records, so no extra lookups are needed.
const INCIDENT_FIELDS = 'sys_id,number,short_description,description,cmdb_ci.serial_number,caller_id.name,caller_id.email';

export class ServiceNowClient {
  constructor(settings) {
    this.settings = settings;
    this.baseUrl = settings.BaseUrl.replace(/\/+$/, '');
    this.accessToken = null;
  }

  // PRODUCTION NOTE: the password grant needs an integration user's password, and the token is
  // fetched once and never refreshed (fine for a short run; ServiceNow tokens last about 30 minutes).
  // Prefer an auth method without a stored user password (e.g. OAuth client credentials or JWT bearer,
  // if your instance allows it), refresh the token before it expires, and give the integration user
  // only the roles it needs.
  async connect() {
    const response = await fetch(`${this.baseUrl}/oauth_token.do`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: this.settings.ClientId,
        client_secret: this.settings.ClientSecret,
        username: this.settings.Username,
        password: this.settings.Password,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ServiceNow ${response.status} oauth_token.do: ${await response.text()}`);
    }
    this.accessToken = (await response.json()).access_token;
  }

  async getGroupId(groupName) {
    const groups = await this.query('sys_user_group', `name=${groupName}`, 'sys_id', 1);
    return groups[0]?.sys_id ?? null;
  }

  // Active incidents assigned to the group, skipping the excluded states. Read every run;
  // the state file tells us which ones are new.
  // PRODUCTION NOTE: reading every active incident each run is simple but grows with the queue.
  // For a busy group, also filter on sys_updated_on (with an overlap) so each run reads only recent changes.
  async getActiveIncidents(groupId, excludedStates) {
    let query = `active=true^assignment_group=${groupId}`;
    for (const state of excludedStates) {
      query += `^state!=${state}`;
    }
    query += '^ORDERBYsys_id'; // stable order so paging doesn't skip or repeat records

    const incidents = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.query('incident', query, INCIDENT_FIELDS, PAGE_SIZE, offset);
      incidents.push(...page);
      if (page.length < PAGE_SIZE) return incidents;
    }
  }

  async findCiBySerial(serialNumber) {
    // "^" would start a new condition in the query, so never pass it through.
    if (serialNumber.includes('^')) return null;
    const cis = await this.query('cmdb_ci', `serial_number=${serialNumber}`, 'sys_id', 1);
    return cis[0] ?? null;
  }

  // Returns { sys_id, number } of the new incident.
  async createIncident(fields) {
    // Leave out empty fields (e.g. no matching CI) rather than sending null.
    const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
    return this.request('POST', 'api/now/table/incident?sysparm_fields=sys_id,number', body);
  }

  async closeIncident(incidentSysId, closeNotes) {
    await this.request('PATCH', `api/now/table/incident/${incidentSysId}?sysparm_fields=sys_id`, {
      state: this.settings.ClosedState,
      close_code: this.settings.CloseCode,
      close_notes: closeNotes,
    });
  }

  // GET api/now/table/{table} with an encoded query.
  async query(table, query, fields, limit, offset = 0) {
    const params = new URLSearchParams({
      sysparm_query: query,
      sysparm_fields: fields,
      sysparm_limit: String(limit),
      sysparm_offset: String(offset),
    });
    return this.request('GET', `api/now/table/${table}?${params}`);
  }

  // ServiceNow wraps every response body in { "result": ... }.
  // PRODUCTION NOTE: no retries (see the same note in id136Client.js).
  async request(method, relativeUrl, body) {
    if (!this.accessToken) throw new Error('Call connect() first');

    const url = `${this.baseUrl}/${relativeUrl}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ServiceNow ${response.status} ${url}: ${await response.text()}`);
    }
    return (await response.json()).result;
  }
}
