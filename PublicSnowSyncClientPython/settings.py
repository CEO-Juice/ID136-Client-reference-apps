"""Reads appsettings.json, then appsettings.local.json (optional, not committed) on top of it
for real secrets. Both files live in the app folder.

PRODUCTION NOTE: secrets in a plain JSON file are readable by anyone who can read the folder.
Load them from a secret store instead (environment variables, the keyring package, Azure Key Vault,
AWS Secrets Manager, ...), and never commit them.
"""
import json
import os

from id136_client import uses_token


def load_settings(app_dir):
    with open(os.path.join(app_dir, "appsettings.json"), encoding="utf-8") as f:
        settings = json.load(f)

    local_path = os.path.join(app_dir, "appsettings.local.json")
    if os.path.exists(local_path):
        with open(local_path, encoding="utf-8") as f:
            _merge(settings, json.load(f))

    settings.setdefault("Id136", {}).setdefault("CompletedStatuses", [])
    settings.setdefault("ServiceNow", {}).setdefault("ExcludedStates", [])
    settings.setdefault("StateFile", "sync-state.json")
    return settings


def find_missing_settings(settings):
    """Returns the names of required settings that are still empty or placeholders.

    PRODUCTION NOTE: this only checks that values are present. It does not check that the base URLs
    use https (they should; the API key and passwords travel in every request), or that the assignment
    group and state values are sensible. Validate them before you rely on them.
    """
    id136 = settings["Id136"]
    snow = settings["ServiceNow"]
    required = {
        "Id136:BaseUrl": id136.get("BaseUrl"),
        **({"Id136:Password": id136.get("Password")} if uses_token(id136)
           else {"Id136:ApiKey (or Id136:Username and Id136:Password)": id136.get("ApiKey")}),
        "ServiceNow:BaseUrl": snow.get("BaseUrl"),
        "ServiceNow:ClientId": snow.get("ClientId"),
        "ServiceNow:ClientSecret": snow.get("ClientSecret"),
        "ServiceNow:Username": snow.get("Username"),
        "ServiceNow:Password": snow.get("Password"),
        "ServiceNow:AssignmentGroup": snow.get("AssignmentGroup"),
    }
    missing = [name for name, value in required.items()
               if not value or not str(value).strip() or str(value).startswith("<")]
    if not id136["CompletedStatuses"]:
        missing.append("Id136:CompletedStatuses")
    return missing


def _merge(target, source):
    """Copies values from source into target; nested sections are merged, everything else replaced."""
    for key, value in source.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge(target[key], value)
        else:
            target[key] = value
