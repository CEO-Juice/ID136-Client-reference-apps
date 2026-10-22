"""Talks to the ID136 Client Services API, which reads and creates e-automate service calls.
Every request carries the API key in the "eaapikey" header. JSON property names are camelCase.

A service call looks like:
  { callId, callNumber, status, description, notes, caller, date, closeDate, lastUpdate,
    equipment: { serialNumber, equipmentNumber } }   # equipment only with includeDetails=true
status is padded with spaces in e-automate ("I "), so always compare it trimmed.
"""
from datetime import datetime

import http_client

PAGE_SIZE = 1000  # the API maximum


class Id136Client:
    def __init__(self, settings):
        self.base_url = settings["BaseUrl"].rstrip("/")
        self.api_key = settings["ApiKey"]

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
        return http_client.send("ID136", method, f"{self.base_url}/{relative_url}",
                                headers={"eaapikey": self.api_key}, json_body=body)
