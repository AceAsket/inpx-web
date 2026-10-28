'use strict';
const started = Date.now();
fetch(process.argv[2] + '/ready', {signal: AbortSignal.timeout(6000)}).then(async response => {
    console.log(JSON.stringify({reachable: response.ok, ms: Date.now() - started, body: await response.json()}));
}).catch(error => console.log(JSON.stringify({reachable: false, ms: Date.now() - started, error: error.message})));
