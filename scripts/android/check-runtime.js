const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const assert = require('assert');
const {execFileSync} = require('child_process');

(async() => {
    const root = path.resolve(__dirname, '../..');
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-android-runtime-'));
    try {
        const runtime = path.join(sandbox, 'runtime');
        await fs.copy(path.join(root, 'dist/android-runtime'), runtime);
        const manifest = await fs.readJson(path.join(runtime, 'runtime-manifest.json'));
        assert.strictEqual(manifest.backendVersion, require('../../package.json').version);
        // Resolving in a temporary directory prevents undeclared dependencies from leaking in from the source workspace.
        execFileSync(process.execPath, ['-e', `
            const fs = require('fs'), path = require('path');
            const root = process.argv[1];
            const local = require('module').createRequire(path.join(root, 'package.json'));
            const manifest = local('./runtime-manifest.json');
            for (const name of manifest.backendPackages) {
                const file = local.resolve(name);
                if (!file.startsWith(root + path.sep)) throw new Error('Dependency outside runtime: ' + name);
                local(name);
            }
            console.log('ok isolated Android dependencies: ' + manifest.backendPackages.length);
        `, runtime], {env:{...process.env, NODE_PATH:''}, windowsHide:true, stdio:'inherit'});
        execFileSync(process.execPath, [path.join(root, 'scripts/binary-smoke-test.js'), '--runtime', runtime],
            {env:{...process.env, NODE_PATH:''}, windowsHide:true, stdio:'inherit', timeout:90000});
    } finally {await fs.remove(sandbox);}
})().catch(error => {console.error(error.stack); process.exitCode = 1;});
