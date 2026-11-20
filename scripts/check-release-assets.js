const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {checkArchivePermissions} = require('./release-archive-smoke-test');
const {name, version} = require('../package.json');

async function main(directory) {
    for (const target of ['linux', 'linux-arm64', 'macos', 'win']) {
        const prefix = path.join(directory, 'release-' + target, `${name}-${version}-${target}`);
        const expected = [path.basename(prefix) + '.zip'];
        if (target === 'win') {
            const installer = prefix + '-rust-setup.exe';
            expected.push(path.basename(installer));
            const file = await fs.stat(installer);
            assert(file.isFile() && file.size > 0, 'Missing installer: ' + installer);
        }
        assert.deepEqual((await fs.readdir(path.dirname(prefix))).sort(), expected.sort());
        await checkArchivePermissions(prefix + '.zip', target, true, true);
    }
    console.log('Verified four Rust archives and the Windows installer');
}

main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
