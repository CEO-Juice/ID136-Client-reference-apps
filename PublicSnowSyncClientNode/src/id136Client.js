// Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
// Every request carries either the API key in the "eaapikey" header or, when a username is set,
// a bearer token from POST api/auth/token. JSON property names are camelCase.
//
// A service call looks like:
//   { callId, callNumber, status, description, notes, caller, date, closeDate, lastUpdate,
//     equipment: { serialNumber, equipmentNumber } }   // equipment only with includeDetails=true
// status is padded with spaces in e-automate ("I "), so always compare it trimmed.

const PAGE_SIZE = 1000; // the API maximum
const TIMEOUT_MS = 60_000;
// Tokens last 60 minutes and can't be refreshed; get a new one when this little is left.
const TOKEN_RENEW_BEFORE_MS = 5 * 60_000;

// True when the settings ask for a bearer token (username and password) rather than an API key.
export function usesToken(settings) {
  return Boolean(settings.Username) && !String(settings.Username).startsWith('<');
}

export class Id136Client {
  constructor(settings) {
    this.baseUrl = settings.BaseUrl.replace(/\/+$/, '');
    this.settings = settings;
    this.token = null;
    this.tokenExpires = 0;
  }

  // With no watermark: all open calls. Otherwise: every call changed since then,
  // in any status (open, completed, canceled). includeDetails adds the equipment serial.
  async getCalls(changedSince) {
    const path = changedSince
      ? `api/ServiceCall/Recentchanges/${changedSince}`
      : 'api/ServiceCall/AllOpen/';

    // List endpoints return one page at a time: { page, pageSize, totalCount, totalPages, items }
    const calls = [];
    let page = 1;
    let totalPages;
    do {
      const result = await this.request('GET', `${path}?page=${page}&pageSize=${PAGE_SIZE}&includeDetails=true`);
      calls.push(...result.items);
      totalPages = result.totalPages;
      page++;
    } while (page <= totalPages);

    return calls;
  }

  // Creates an e-automate call and returns it (with its new callId and callNumber).
  // The equipment, and so the customer, is found by serialNumber. referenceCallIdentifier is
  // required: if a call with that reference already exists, the API returns it instead.
  async addCall({ description, notes, serialNumber, contact, callType, referenceCallIdentifier }) {
    return this.request('PUT', 'api/ServiceCall/AddCall/', {
      description,
      notes,
      serialNumber,
      contact,
      callType,
      referenceCallIdentifier,
      callDate: new Date().toISOString(),
    });
  }

  // PRODUCTION NOTE: no retries. A timeout, HTTP 429 (rate limited) or 5xx fails the item and it is
  // tried again next run. Add retries with backoff and respect the Retry-After header.
  async request(method, relativeUrl, body) {
    const auth = usesToken(this.settings)
      ? { Authorization: `Bearer ${await this.getToken()}` }
      : { eaapikey: this.settings.ApiKey };
    return this.send(method, relativeUrl, body, auth);
  }

  // Exchanges the username and password for a bearer token, reusing it until it is about to expire.
  // PRODUCTION NOTE: the token endpoint is rate limited, so keep reusing the token rather than
  // asking for one per request, and keep the password in a secret store, not in appsettings.
  async getToken() {
    if (this.token && Date.now() < this.tokenExpires - TOKEN_RENEW_BEFORE_MS) {
      return this.token;
    }
    const result = await this.send('POST', 'api/auth/token',
      { username: this.settings.Username, password: this.settings.Password }, {});
    this.token = result.token;
    this.tokenExpires = Date.parse(result.expires);
    return this.token;
  }

  async send(method, relativeUrl, body, auth) {
    const url = `${this.baseUrl}/${relativeUrl}`;
    const response = await fetch(url, {
      method,
      headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`ID136 ${response.status} ${url}: ${await response.text()}`);
    }
    return response.json();
  }
}
