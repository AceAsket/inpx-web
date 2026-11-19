const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {checkArchivePermissions} = require('./release-archive-smoke-test');
const {name, version} = require('../package.json');

async function main(directory) {
    for (const target of ['linux', 'linux-arm64', 'macos', 'win']) {
        const prefix = path.join(directory, 'release-' + target, `${name}-${version}-${target}`);
        await checkArchivePermissions(prefix + '.zip', target, true, false, version === '1.8.3');
        await checkArchivePermissions(prefix + '-rust.zip', target, true, true);
        if (target === 'win') {
            for (const suffix of ['-setup.exe', '-rust-setup.exe']) {
                const file = await fs.stat(prefix + suffix);
                assert(file.isFile() && file.size > 0, 'Missing installer: ' + prefix + suffix);
            }
        }
    }
    console.log('Verified the release archives for all four targets and both Windows installers');
}

main(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
