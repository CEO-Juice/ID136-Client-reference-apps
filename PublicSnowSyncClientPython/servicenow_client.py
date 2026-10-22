"""Talks to the ServiceNow Table API (api/now/table/...). Authenticates once per run
with the OAuth password grant and sends the token on every request."""
import urllib.parse

import http_client

PAGE_SIZE = 500

# "Dot-walked" fields (cmdb_ci.serial_number, caller_id.*) bring in values from the linked
# CI and caller records, so no extra lookups are needed.
INCIDENT_FIELDS = "sys_id,number,short_description,description,cmdb_ci.serial_number,caller_id.name,caller_id.email"


class ServiceNowClient:
    def __init__(self, settings):
        self.settings = settings
        self.base_url = settings["BaseUrl"].rstrip("/")
        self.access_token = None

    def connect(self):
        """PRODUCTION NOTE: the password grant needs an integration user's password, and the token is
        fetched once and never refreshed (fine for a short run; ServiceNow tokens last about 30 minutes).
        Prefer an auth method without a stored user password (e.g. OAuth client credentials or JWT bearer,
        if your instance allows it), refresh the token before it expires, and give the integration user
        only the roles it needs."""
        result = http_client.send("ServiceNow", "POST", f"{self.base_url}/oauth_token.do", form={
            "grant_type": "password",
            "client_id": self.settings["ClientId"],
            "client_secret": self.settings["ClientSecret"],
            "username": self.settings["Username"],
            "password": self.settings["Password"],
        })
        self.access_token = result["access_token"]

    def get_group_id(self, group_name):
        groups = self._query("sys_user_group", f"name={group_name}", "sys_id", 1)
        return groups[0]["sys_id"] if groups else None

    def get_active_incidents(self, group_id, excluded_states):
        """Active incidents assigned to the group, skipping the excluded states. Read every run;
        the state file tells us which ones are new.

        PRODUCTION NOTE: reading every active incident each run is simple but grows with the queue.
        For a busy group, also filter on sys_updated_on (with an overlap) so each run reads only recent changes."""
        query = f"active=true^assignment_group={group_id}"
        for state in excluded_states:
            query += f"^state!={state}"
        query += "^ORDERBYsys_id"  # stable order so paging doesn't skip or repeat records

        incidents = []
        offset = 0
        while True:
            page = self._query("incident", query, INCIDENT_FIELDS, PAGE_SIZE, offset)
            incidents.extend(page)
            if len(page) < PAGE_SIZE:
                return incidents
            offset += PAGE_SIZE

    def find_ci_by_serial(self, serial_number):
        # "^" would start a new condition in the query, so never pass it through.
        if "^" in serial_number:
            return None
        cis = self._query("cmdb_ci", f"serial_number={serial_number}", "sys_id", 1)
        return cis[0] if cis else None

    def create_incident(self, fields):
        """Returns { sys_id, number } of the new incident."""
        # Leave out empty fields (e.g. no matching CI) rather than sending null.
        body = {key: value for key, value in fields.items() if value is not None}
        return self._request("POST", "api/now/table/incident?sysparm_fields=sys_id,number", body)

    def close_incident(self, incident_sys_id, close_notes):
        self._request("PATCH", f"api/now/table/incident/{incident_sys_id}?sysparm_fields=sys_id", {
            "state": self.settings["ClosedState"],
            "close_code": self.settings["CloseCode"],
            "close_notes": close_notes,
        })

    def _query(self, table, query, fields, limit, offset=0):
        """GET api/now/table/{table} with an encoded query."""
        params = urllib.parse.urlencode({
            "sysparm_query": query,
            "sysparm_fields": fields,
            "sysparm_limit": limit,
            "sysparm_offset": offset,
        })
        return self._request("GET", f"api/now/table/{table}?{params}")

    def _request(self, method, relative_url, body=None):
        """ServiceNow wraps every response body in { "result": ... }.
        PRODUCTION NOTE: no retries (see http_client.py)."""
        if not self.access_token:
            raise RuntimeError("Call connect() first")
        result = http_client.send("ServiceNow", method, f"{self.base_url}/{relative_url}",
                                  headers={"Authorization": f"Bearer {self.access_token}"}, json_body=body)
        return result["result"]
