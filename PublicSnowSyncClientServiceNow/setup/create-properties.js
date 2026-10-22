/*
 * One-time setup: creates the eautomate.sync.* system properties that EautomateSync reads.
 * Run in System Definition > Scripts - Background (global scope).
 *
 * Edit the values below first. Existing properties are left alone, so it is safe to run again.
 * Never put the API key or password here: they belong in a credential record (see the README), and
 * eautomate.sync.id136.credential only holds that credential's sys_id.
 */
(function() {
    var properties = [
        ['id136.base_url', 'https://devclientsapi.ceojuice.com/', 'ID136 API address (from your e-automate dealer)'],
        ['id136.credential', '', 'sys_id of the ID136 credential: an API Key credential, or a Basic Auth credential (username and password)'],
        ['id136.call_type', '', 'e-automate call type code for calls created from incidents (optional)'],
        ['id136.completed_statuses', 'OKB,I,CMP,C', 'e-automate call statuses that close the linked incident'],
        ['assignment_group', '', 'Assignment group name: its incidents are sent to e-automate, and new incidents are assigned to it'],
        ['excluded_states', '6', 'Incident states not sent to e-automate (comma-separated)'],
        ['urgency', '3', 'Urgency for incidents created from e-automate calls'],
        ['impact', '2', 'Impact for incidents created from e-automate calls'],
        ['closed_state', '6', 'State set when the linked e-automate call is completed'],
        ['close_code', 'Solved (Permanently)', 'Resolution code set when the linked e-automate call is completed'],
        ['last_call_update_seen', '', 'Set by the sync: newest e-automate lastUpdate seen. Clear it to re-read all open calls']
    ];

    for (var i = 0; i < properties.length; i++) {
        var name = 'eautomate.sync.' + properties[i][0];
        var property = new GlideRecord('sys_properties');
        if (property.get('name', name)) {
            gs.print('Exists, left alone: ' + name);
            continue;
        }
        property.initialize();
        property.setValue('name', name);
        property.setValue('value', properties[i][1]);
        property.setValue('description', properties[i][2]);
        property.setValue('type', 'string');
        property.insert();
        gs.print('Created: ' + name);
    }
})();
