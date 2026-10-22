"""Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
Every request carries either the API key in the "eaapikey" header or, when a username is set,
a bearer token from POST api/auth/token. JSON property names are camelCase.

A service call looks like:
  { callId, callNumber, status, description, notes, caller, date, closeDate, lastUpdate,
    equipment: { serialNumber, equipmentNumber } }   # equipment only with includeDetails=true
status is padded with spaces in e-automate ("I "), so always compare it trimmed.
"""
import re
from datetime import datetime, timedelta, timezone

import http_client

PAGE_SIZE = 1000  # the API maximum
# Tokens last 60 minutes and can't be refreshed; get a new one when this little is left.
TOKEN_RENEW_BEFORE = timedelta(minutes=5)


def uses_token(settings):
    """True when the settings ask for a bearer token (username and password) rather than an API key."""
    username = settings.get("Username") or ""
    return bool(username.strip()) and not username.startswith("<")


class Id136Client:
    def __init__(self, settings):
        self.base_url = settings["BaseUrl"].rstrip("/")
        self.settings = settings
        self.token = None
        self.token_expires = datetime.min.replace(tzinfo=timezone.utc)

    def get_calls(self, changed_since):
        """With no watermark: all open calls. Otherwise: every call changed since then,
        in any status (open, completed, canceled). includeDetails adds the equipment serial."""
        if changed_since:
            path = f"api/ServiceCall/Recentchanges/{changed_since}"
        else:
            path = "api/ServiceCall/AllOpen/"

        # List endpoints return one page at a time: { page, pageSize, totalCount, totalPages, items }
        calls = []
        page = 1
        while True:
            result = self._request("GET", f"{path}?page={page}&pageSize={PAGE_SIZE}&includeDetails=true")
            calls.extend(result.get("items") or [])
            if page >= (result.get("totalPages") or 0):
                return calls
            page += 1

    def add_call(self, description, notes, serial_number, contact, call_type, reference_call_identifier):
        """Creates an e-automate call and returns it (with its new callId and callNumber).
        The equipment, and so the customer, is found by serialNumber. referenceCallIdentifier is
        required: if a call with that reference already exists, the API returns it instead."""
        body = {
            "description": description,
            "notes": notes,
            "serialNumber": serial_number,
            "contact": contact,
            "referenceCallIdentifier": reference_call_identifier,
            "callDate": datetime.now().isoformat(),
        }
        if call_type:
            body["callType"] = call_type
        return self._request("PUT", "api/ServiceCall/AddCall/", body)

    def _request(self, method, relative_url, body=None):
        if uses_token(self.settings):
            headers = {"Authorization": f"Bearer {self._get_token()}"}
        else:
            headers = {"eaapikey": self.settings["ApiKey"]}
        return http_client.send("ID136", method, f"{self.base_url}/{relative_url}",
                                headers=headers, json_body=body)

    def _get_token(self):
        """Exchanges the username and password for a bearer token, reusing it until it is about to expire.

        PRODUCTION NOTE: the token endpoint is rate limited, so keep reusing the token rather than
        asking for one per request, and keep the password in a secret store, not in appsettings."""
        if self.token and datetime.now(timezone.utc) < self.token_expires - TOKEN_RENEW_BEFORE:
            return self.token

        result = http_client.send("ID136", "POST", f"{self.base_url}/api/auth/token",
                                  json_body={"username": self.settings["Username"],
                                             "password": self.settings["Password"]})
        self.token = result["token"]
        # e.g. "2026-07-27T18:30:00.1234567Z". Drop the fraction (Python reads at most 6 digits)
        # and spell out the UTC offset, which older Pythons need.
        expires = re.sub(r"\.\d+", "", result["expires"]).replace("Z", "+00:00")
        self.token_expires = datetime.fromisoformat(expires)
        return self.token
