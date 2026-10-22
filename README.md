# e-automate ↔ ServiceNow reference integrations

Small reference integrations that sync service calls between **e-automate** (through the ID136 API) and **ServiceNow** incidents. Each folder does the same thing in a different language; pick whichever suits you as a starting point for your own integration.

| Folder | Language |
|---|---|
| [PublicSnowSyncClient](PublicSnowSyncClient/README.md) | .NET (open `PublicSnowSyncClient.sln`) |
| [PublicSnowSyncClientNode](PublicSnowSyncClientNode/README.md) | Node.js |
| [PublicSnowSyncClientPowerShell](PublicSnowSyncClientPowerShell/README.md) | PowerShell |
| [PublicSnowSyncClientPython](PublicSnowSyncClientPython/README.md) | Python |
| [PublicSnowSyncClientServiceNow](PublicSnowSyncClientServiceNow/README.md) | Runs inside ServiceNow (script include + scheduled job) |

None of these is production-ready as is; each README has a "Before using this in production" section.
