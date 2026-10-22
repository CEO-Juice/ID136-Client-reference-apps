/*
 * Script Include: EautomateSync
 *
 * Reference integration between e-automate (through the ID136 API) and ServiceNow, running
 * inside ServiceNow. A Scheduled Script Execution calls new EautomateSync().run() every few minutes.
 *
 *   1. ServiceNow -> e-automate: new incidents in the assignment group become service calls.
 *   2. e-automate -> ServiceNow: new open service calls become incidents.
 *   3. e-automate -> ServiceNow: completed calls close their incident.
 *
 * There is no state file: the link to the e-automate call is stored on the incident itself,
 * in correlation_id ("EAUTO-<callId>") and correlation_display (the call number). The only
 * other state is the watermark, kept in a system property.
 *
 * Settings are system properties named eautomate.sync.* (see setup/create-properties.js).
 * The ID136 API key is read from an API Key credential record, never from a property.
 *
 * Written in ES5 so it works in the global scope on any ServiceNow release.
 *
 * THIS IS A REFERENCE SCRIPT, NOT A PRODUCTION INTEGRATION. It is kept short so it is easy to read.
 * Places where it takes a shortcut you should not ship are marked "PRODUCTION NOTE:"
 * (search for that text). The README has the same list under "Before using this in production".
 */
var EautomateSync = Class.create();
EautomateSync.prototype = {

    PROPERTY_PREFIX: 'eautomate.sync.',
    CORRELATION_PREFIX: 'EAUTO-',    // marks incidents linked by this integration
    PAGE_SIZE: 1000,                 // ID136 maximum
    TIMEOUT_MS: 60000,
    WATERMARK_OVERLAP_SECONDS: 15 * 60,
    OPEN_STATUSES: ['P', 'D', 'A', 'H'],

    initialize: function() {
        this.baseUrl = this._property('id136.base_url', '').replace(/\/+$/, '');
        this.apiKey = this._readApiKey(this._property('id136.credential', ''));
        this.callType = this._property('id136.call_type', '');
        this.completedStatuses = this._list(this._property('id136.completed_statuses', 'OKB,I,CMP,C'));
        this.groupName = this._property('assignment_group', '');
        this.excludedStates = this._list(this._property('excluded_states', '6'));
        this.urgency = this._property('urgency', '3');
        this.impact = this._property('impact', '2');
        this.closedState = this._property('closed_state', '6');
        this.closeCode = this._property('close_code', 'Solved (Permanently)');
    },

    // Entry point for the scheduled job. Returns true when everything synced.
    run: function() {
        try {
            if (!this.baseUrl || !this.apiKey || !this.groupName) {
                this._log('error', 'Missing settings: check the eautomate.sync.* system properties and the API key credential');
                return false;
            }
            var groupId = this._findGroupId(this.groupName);
            if (!groupId) {
                this._log('error', "Assignment group '" + this.groupName + "' not found");
                return false;
            }

            var failures = 0;

            // 1. ServiceNow -> e-automate
            failures += this._syncIncidentsToCalls(groupId);

            // 2 and 3 use the same list of calls from ID136.
            var lastSeen = this._property('last_call_update_seen', '');
            var changedSince = lastSeen ? this._eautoTimeMinusSeconds(lastSeen, this.WATERMARK_OVERLAP_SECONDS) : '';
            var calls = this._getCalls(changedSince);
            this._log('info', changedSince
                ? calls.length + ' calls changed in e-automate since ' + changedSince
                : calls.length + ' open calls in e-automate (first run)');

            failures += this._syncCallsToIncidents(calls, groupId);
            failures += this._closeCompletedIncidents(calls);

            // Only move the watermark forward when everything worked, so failed calls are read again next run.
            // PRODUCTION NOTE: one call that can never succeed (e.g. bad data) holds the watermark back for
            // good, so every run re-reads an ever-growing window. Track repeated failures per call, park them
            // after a few attempts (a "dead letter" list someone reviews), and let the watermark move on.
            if (failures === 0 && calls.length > 0) {
                var newest = lastSeen;
                for (var i = 0; i < calls.length; i++) {
                    var time = this._eautoTime(calls[i].lastUpdate);
                    if (!newest || time > newest) newest = time;   // fixed-width text sorts correctly
                }
                gs.setProperty(this.PROPERTY_PREFIX + 'last_call_update_seen', newest);
            }

            this._log('info', failures === 0 ? 'Sync finished' : 'Sync finished with ' + failures + ' failure(s); they will be retried next run');
            return failures === 0;
        }
        catch (e) {
            // PRODUCTION NOTE: failures only show up in the system log. Send them somewhere someone will
            // see (an event and notification, a task for the integration owner, or your monitoring).
            this._log('error', 'Sync stopped: ' + e);
            return false;
        }
    },

    // ---------- 1. ServiceNow incident -> new e-automate call ----------
    _syncIncidentsToCalls: function(groupId) {
        var failures = 0;

        // Not yet linked (no correlation_id) and with a CI that has a serial number.
        // e-automate finds the equipment (and so the customer) by serial number.
        // PRODUCTION NOTE: active incidents without a CI serial are silently left out by this query.
        // Report them (or add a CI) if your process expects every incident to reach e-automate.
        var incident = new GlideRecord('incident');
        incident.addEncodedQuery(this._incidentQuery(groupId) +
            '^correlation_idISEMPTY^cmdb_ci.serial_numberISNOTEMPTY');
        incident.query();

        var count = 0;
        while (incident.next()) {
            count++;
            var number = incident.getValue('number');
            try {
                // PRODUCTION NOTE: the field mapping is minimal and nothing is shortened or cleaned up.
                // e-automate limits the description (about 210 characters after the reference prefix) and
                // the caller field; map the fields your process needs and trim them to fit.
                // Also, if a call already exists for this incident number (even a closed one), ID136
                // returns that call instead of creating a new one; check its status if that matters to you.
                var newCall = {
                    description: incident.getValue('short_description') || number,
                    notes: incident.getValue('description') || '',
                    serialNumber: incident.cmdb_ci.serial_number.toString(),
                    contact: (incident.caller_id.getDisplayValue() + ' ' + incident.caller_id.email).trim(),
                    referenceCallIdentifier: number,
                    callDate: new GlideDateTime().getValue().replace(' ', 'T')
                };
                if (this.callType) newCall.callType = this.callType;

                var call = this._id136('put', 'api/ServiceCall/AddCall/', newCall);

                // Link the incident to the call. This is what stops it being sent twice.
                incident.setValue('correlation_id', this.CORRELATION_PREFIX + call.callId);
                incident.setValue('correlation_display', call.callNumber);
                incident.work_notes = 'Created e-automate service call ' + call.callNumber;
                incident.update();
                this._log('info', 'Created call ' + call.callNumber + ' from incident ' + number);
            }
            catch (e) {
                this._log('error', 'Could not create a call for incident ' + number + ': ' + e);
                failures++;
            }
        }
        this._log('info', count + ' new incidents to send to e-automate');
        return failures;
    },

    // ---------- 2. e-automate call -> new ServiceNow incident ----------
    _syncCallsToIncidents: function(calls, groupId) {
        var failures = 0;
        for (var i = 0; i < calls.length; i++) {
            var call = calls[i];

            // PRODUCTION NOTE: every open call the API key can see becomes an incident. If the key covers
            // several customers or locations, filter here (e.g. by customerId or call type) so only the calls
            // meant for this instance are created.
            if (this.OPEN_STATUSES.indexOf(this._status(call.status)) === -1) continue;
            if (this._findLinkedIncident(call.callId, false)) continue;  // already linked (including calls created in step 1)

            var serial = call.equipment && call.equipment.serialNumber ? String(call.equipment.serialNumber).trim() : '';
            if (!serial) {
                this._log('warn', 'Skipping call ' + call.callNumber + ': no equipment serial number');
                continue;
            }

            try {
                var ciId = this._findCiBySerial(serial);
                if (!ciId) {
                    this._log('warn', 'Call ' + call.callNumber + ': no CI with serial ' + serial + '; creating the incident without one');
                }

                // PRODUCTION NOTE: values are set as-is. short_description holds 160 characters by default,
                // and the caller, category and other fields your instance requires are not set.
                var incident = new GlideRecord('incident');
                incident.initialize();
                incident.setValue('short_description', call.description || 'Service call ' + call.callNumber);
                incident.setValue('description', 'e-automate service call ' + call.callNumber + '\n\n' + (call.notes || ''));
                if (ciId) incident.setValue('cmdb_ci', ciId);
                incident.setValue('assignment_group', groupId);
                incident.setValue('urgency', this.urgency);
                incident.setValue('impact', this.impact);
                incident.setValue('correlation_id', this.CORRELATION_PREFIX + call.callId);
                incident.setValue('correlation_display', call.callNumber);
                incident.insert();
                this._log('info', 'Created incident ' + incident.getValue('number') + ' from call ' + call.callNumber);
            }
            catch (e) {
                this._log('error', 'Could not create an incident for call ' + call.callNumber + ': ' + e);
                failures++;
            }
        }
        return failures;
    },

    // ---------- 3. completed e-automate call -> close the ServiceNow incident ----------
    _closeCompletedIncidents: function(calls) {
        var failures = 0;
        for (var i = 0; i < calls.length; i++) {
            var call = calls[i];
            var status = this._status(call.status);
            if (this.completedStatuses.indexOf(status) === -1) continue;

            var incident = this._findLinkedIncident(call.callId, true);  // linked and still open
            if (!incident) continue;

            try {
                // PRODUCTION NOTE: the e-automate call notes become the incident's close notes, which
                // ServiceNow users can read. If your notes can hold internal or sensitive text, filter them
                // or use a fixed message instead.
                incident.setValue('state', this.closedState);
                incident.setValue('close_code', this.closeCode);
                incident.setValue('close_notes', call.notes || 'Completed in e-automate as call ' + call.callNumber);
                incident.update();
                this._log('info', 'Closed incident ' + incident.getValue('number') + ': call ' + call.callNumber + ' is ' + status);
            }
            catch (e) {
                this._log('error', 'Could not close the incident for call ' + call.callNumber + ': ' + e);
                failures++;
            }
        }
        return failures;
    },

    // ---------- ID136 API ----------

    // With no watermark: all open calls. Otherwise: every call changed since then,
    // in any status (open, completed, canceled). includeDetails adds the equipment serial.
    _getCalls: function(changedSince) {
        var path = changedSince ? 'api/ServiceCall/Recentchanges/' + changedSince : 'api/ServiceCall/AllOpen/';

        // List endpoints return one page at a time: { page, pageSize, totalCount, totalPages, items }
        var calls = [];
        var page = 1;
        var totalPages;
        do {
            var result = this._id136('get', path + '?page=' + page + '&pageSize=' + this.PAGE_SIZE + '&includeDetails=true');
            calls = calls.concat(result.items || []);
            totalPages = result.totalPages;
            page++;
        } while (page <= totalPages);
        return calls;
    },

    // PRODUCTION NOTE: no retries. A timeout, HTTP 429 (rate limited) or 5xx fails the item and it is
    // tried again next run. Add retries with backoff, or move the call into a Flow Designer action
    // with retry settings. If ID136 is only reachable from your network, route it through a MID Server
    // (request.setMIDServer).
    _id136: function(method, relativeUrl, body) {
        var request = new sn_ws.RESTMessageV2();
        request.setEndpoint(this.baseUrl + '/' + relativeUrl);
        request.setHttpMethod(method);
        request.setRequestHeader('eaapikey', this.apiKey);
        request.setRequestHeader('Accept', 'application/json');
        request.setHttpTimeout(this.TIMEOUT_MS);
        if (body) {
            request.setRequestHeader('Content-Type', 'application/json');
            request.setRequestBody(JSON.stringify(body));
        }

        var response = request.execute();
        var status = response.getStatusCode();
        if (response.haveError() || status < 200 || status >= 300) {
            throw 'ID136 ' + status + ' ' + relativeUrl + ': ' + (response.getErrorMessage() || '') + ' ' + response.getBody();
        }
        return JSON.parse(response.getBody());
    },

    // The key lives in an API Key credential (Connections & Credentials > Credentials), so it is
    // stored encrypted and never appears in a property, script or log.
    _readApiKey: function(credentialSysId) {
        if (!credentialSysId) return '';
        var credential = new sn_cc.StandardCredentialsProvider().getCredentialByID(credentialSysId);
        return credential ? credential.getAttribute('api_key') : '';
    },

    // ---------- ServiceNow lookups ----------

    _incidentQuery: function(groupId) {
        var query = 'active=true^assignment_group=' + groupId;
        for (var i = 0; i < this.excludedStates.length; i++) {
            query += '^state!=' + this.excludedStates[i];
        }
        return query;
    },

    // The incident linked to this call, or null. activeOnly skips closed incidents.
    _findLinkedIncident: function(callId, activeOnly) {
        var incident = new GlideRecord('incident');
        incident.addQuery('correlation_id', this.CORRELATION_PREFIX + callId);
        if (activeOnly) incident.addActiveQuery();
        incident.setLimit(1);
        incident.query();
        return incident.next() ? incident : null;
    },

    _findGroupId: function(name) {
        var group = new GlideRecord('sys_user_group');
        return group.get('name', name) ? group.getUniqueValue() : null;
    },

    _findCiBySerial: function(serial) {
        var ci = new GlideRecord('cmdb_ci');
        ci.addQuery('serial_number', serial);
        ci.setLimit(1);
        ci.query();
        return ci.next() ? ci.getUniqueValue() : null;
    },

    // ---------- Helpers ----------

    _property: function(name, defaultValue) {
        return gs.getProperty(this.PROPERTY_PREFIX + name, defaultValue);
    },

    _list: function(commaSeparated) {
        var items = [];
        var parts = String(commaSeparated || '').split(',');
        for (var i = 0; i < parts.length; i++) {
            var item = this._status(parts[i]);
            if (item) items.push(item);
        }
        return items;
    },

    // e-automate pads status codes with spaces ("I "), so compare them trimmed.
    _status: function(status) {
        return String(status || '').trim().toUpperCase();
    },

    // e-automate times have no time zone ("2026-10-21T11:06:00"). Keep them as text in that fixed
    // format so the instance's time zone never shifts them.
    _eautoTime: function(value) {
        return String(value || '').substring(0, 19);
    },

    // GlideDateTime's internal value has no time zone applied, so setValue/getValue keep the clock time.
    _eautoTimeMinusSeconds: function(eautoTime, seconds) {
        var time = new GlideDateTime();
        time.setValue(eautoTime.replace('T', ' '));
        time.addSeconds(-seconds);
        return time.getValue().replace(' ', 'T');
    },

    // Shows up in System Logs > System Log > All, with source "EautomateSync".
    // (In the global scope these take a source; gs.info/gs.warn/gs.error don't.)
    // Never log this.apiKey or request headers.
    _log: function(level, message) {
        if (level === 'error') gs.logError(message, 'EautomateSync');
        else if (level === 'warn') gs.logWarning(message, 'EautomateSync');
        else gs.log(message, 'EautomateSync');
    },

    type: 'EautomateSync'
};
