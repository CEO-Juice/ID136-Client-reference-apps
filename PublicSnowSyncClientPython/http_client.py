"""Sends HTTP requests with only the standard library (urllib), shared by both API clients.

PRODUCTION NOTE: no retries. A timeout, HTTP 429 (rate limited) or 5xx fails the item and it is
tried again next run. Add retries with backoff and respect the Retry-After header (or use the
requests package with urllib3's Retry).
"""
import json
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT_SECONDS = 60


def send(name, method, url, headers=None, json_body=None, form=None):
    """Sends a request and returns the parsed JSON response.

    Turns an HTTP error into one exception with the status code and response body."""
    headers = dict(headers or {})
    headers.setdefault("Accept", "application/json")
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{name} {e.code} {url}: {e.read().decode('utf-8', 'replace')}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"{name} {url}: {e.reason}") from None
    return json.loads(body) if body else None
