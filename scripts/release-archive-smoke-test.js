const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const StreamZip = require('node-stream-zip');
const {executableNames} = require('../build/release-archive');

async function checkArchivePermissions(archive, target, converters = true) {
    const zip = new StreamZip.async({file:archive});
    try {
        const entries = await zip.entries();
        for (const name of executableNames(target, converters)) {
            assert(entries[name] && !entries[name].isDirectory, `Missing release executable: ${name}`);
            if (target !== 'win')
                assert.equal((entries[name].attr >>> 16) & 0o7777, 0o755, `ZIP must store mode 755 for ${name}`);
        }
    } finally { await zip.close(); }
}

async function extractArchive(archive, directory) {
    // Use the platform's extractor, without repairing permissions afterwards.
    // Our Node ZIP reader writes fresh files and cannot verify this contract.
    if (process.platform === 'win32') {
        // Use Windows' ZIP extractor: Git's tar treats D: as a remote host,
        // and some system tar versions cannot extract UTF-8 ZIP filenames.
        const powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        execFileSync(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-Command',
            "$ErrorActionPreference='Stop'; [void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); [IO.Compression.ZipFile]::ExtractToDirectory($env:INPX_RELEASE_TEST_ARCHIVE,$env:INPX_RELEASE_TEST_DIRECTORY)"],
        {stdio:'inherit',windowsHide:true,env:{...process.env,INPX_RELEASE_TEST_ARCHIVE:path.resolve(archive),INPX_RELEASE_TEST_DIRECTORY:directory}});
    } else execFileSync('unzip', ['-q', path.resolve(archive), '-d', directory], {stdio:'inherit'});
}

async function main() {
    const [target, archive, ...options] = process.argv.slice(2);
    const converters = !options.includes('--application-only');
    const names = executableNames(target, converters);
    await checkArchivePermissions(archive, target, converters);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-release-extracted-'));
    try {
        await extractArchive(archive, directory);
        for (const name of names) {
            if (target !== 'win')
                assert.equal((await fs.stat(path.join(directory, name))).mode & 0o7777, 0o755, `Extracted mode: ${name}`);
        }
        const run = (script, args) => execFileSync(process.execPath, [path.join(__dirname, script), ...args], {stdio:'inherit', windowsHide:true});
        run('binary-smoke-test.js', [path.join(directory, names[0])]);
        if (converters) {
            run('fb2cng-integration-tests.js', ['--fbc', path.join(directory, names[1])]);
            run('mobi-integration-tests.js', ['--fbc', path.join(directory, names[1]), '--kindling', path.join(directory, names[2])]);
        }
        console.log(`Release ZIP: stored/extracted permissions and real application${converters ? '/EPUB/MOBI' : ''} passed (${target})`);
    } finally { await fs.remove(directory); }
}

module.exports = {checkArchivePermissions, extractArchive};
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
