import fs from 'node:fs';
import path from 'node:path';

// Reads appsettings.json, then appsettings.local.json (optional, not committed) on top of it
// for real secrets. Both files live in the app folder.
// PRODUCTION NOTE: secrets in a plain JSON file are readable by anyone who can read the folder.
// Load them from a secret store instead (environment variables, Windows Credential Manager,
// Azure Key Vault, AWS Secrets Manager, ...), and never commit them.
export function loadSettings(appDir) {
  const settings = readJson(path.join(appDir, 'appsettings.json'));
  const localPath = path.join(appDir, 'appsettings.local.json');
  if (fs.existsSync(localPath)) {
    merge(settings, readJson(localPath));
  }

  settings.Id136 ??= {};
  settings.ServiceNow ??= {};
  settings.Id136.CompletedStatuses ??= [];
  settings.ServiceNow.ExcludedStates ??= [];
  settings.StateFile ??= 'sync-state.json';
  return settings;
}

// Returns the names of required settings that are still empty or placeholders.
// PRODUCTION NOTE: this only checks that values are present. It does not check that the base URLs
// use https (they should; the API key and passwords travel in every request), or that the assignment
// group and state values are sensible. Validate them before you rely on them.
export function findMissingSettings(settings) {
  const required = {
    'Id136:BaseUrl': settings.Id136.BaseUrl,
    'Id136:ApiKey': settings.Id136.ApiKey,
    'ServiceNow:BaseUrl': settings.ServiceNow.BaseUrl,
    'ServiceNow:ClientId': settings.ServiceNow.ClientId,
    'ServiceNow:ClientSecret': settings.ServiceNow.ClientSecret,
    'ServiceNow:Username': settings.ServiceNow.Username,
    'ServiceNow:Password': settings.ServiceNow.Password,
    'ServiceNow:AssignmentGroup': settings.ServiceNow.AssignmentGroup,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value || String(value).trim() === '' || String(value).startsWith('<'))
    .map(([name]) => name);

  if (settings.Id136.CompletedStatuses.length === 0) {
    missing.push('Id136:CompletedStatuses');
  }
  return missing;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Copies values from source into target; nested objects are merged, everything else replaced.
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      merge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}
