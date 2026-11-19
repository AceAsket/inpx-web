const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const StreamZip = require('node-stream-zip');
const {executableNames,rustProgramEntry} = require('../build/release-archive');

async function checkArchivePermissions(archive, target, converters = true, rust = false, classic = false) {
    const zip = new StreamZip.async({file:archive});
    try {
        const entries = await zip.entries();
        if (classic) assert(!entries['bin/' + require('../server/core/RustAuthState').fileName], 'Unexpected Rust authentication module in the classic Node.js archive');
        for (const program of ['server','catalog','reader']) {
            const name = rustProgramEntry(target,program);
            if (classic) assert(!entries[name], 'Unexpected Rust server component in the classic Node.js archive: ' + name);
            if (rust && program === 'server') {
                assert(!entries[name], 'The standalone Rust executable is the archive entry point');
                continue;
            }
            const required = rust || process.env[program==='server' ? 'INPX_SMOKE_REQUIRE_RUST_HTTP' : 'INPX_SMOKE_REQUIRE_RUST_CATALOG']==='true';
            if (required || entries[name]) {
                assert(entries[name] && !entries[name].isDirectory,`Missing Rust executable: ${name}`);
                if (target !== 'win') assert.equal((entries[name].attr >>> 16) & 0o7777,0o755);
            }
        }
        if (rust) {
            assert(entries['bin/public.json'] && !entries['bin/public.json'].isDirectory,'Missing packaged web application');
            assert(!Object.keys(entries).some(name=>/\.(?:node|wasm)$|(?:^|\/)node(?:\.exe)?$/i.test(name)),
                'Rust archive must not contain Node runtimes, addons or its authentication module');
            if (converters) {
                const required = ['bin/LICENSE.kindling', 'bin/LICENSE.quickjs', 'bin/public.json'];
                if (target.startsWith('linux'))
                    required.push('bin/djxl', 'bin/djxl-licenses/LICENSE.jpeg-xl');
                if (target === 'win')
                    required.push('bin/7za.exe', 'bin/djxl.exe', 'bin/dwebp.exe', 'vcruntime140.dll', 'bin/vcruntime140.dll');
                for (const name of required)
                    assert(entries[name]?.size > 0 && !entries[name].isDirectory, `Missing or empty standalone file: ${name}`);
            }
        }
        for (const name of executableNames(target, converters, rust)) {
            assert(entries[name] && !entries[name].isDirectory, `Missing release executable: ${name}`);
            assert(entries[name].size > 0, `Empty release executable: ${name}`);
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
    const rust = options.includes('--rust');
    const names = executableNames(target, converters, rust);
    await checkArchivePermissions(archive, target, converters, rust);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-release-extracted-'));
    try {
        await extractArchive(archive, directory);
        if (target.startsWith('linux')) {
            const djxl = path.join(directory, 'bin', 'djxl');
            assert.equal((await fs.stat(djxl)).mode & 0o7777, 0o755);
            await fs.access(path.join(directory, 'bin', 'djxl-licenses', 'LICENSE.jpeg-xl'));
            execFileSync(djxl, ['--version'], {stdio:'inherit'});
            for (const program of ['server','catalog','reader']) {
                const name = rust && program === 'server' ? names[0] : rustProgramEntry(target,program);
                const binary = path.join(directory,name);
                if (!rust && !await fs.pathExists(binary)) continue;
                const elf = execFileSync('readelf',['-lWd',binary],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}});
                assert.doesNotMatch(elf,/\bINTERP\b|\(NEEDED\)/, `${name} must run without the host's ELF loader and shared libraries`);
            }
        }
        if (!rust) {
            const authState = path.join(directory, 'bin', require('../server/core/RustAuthState').fileName);
            assert(WebAssembly.validate(await fs.readFile(authState)), 'Release must include a valid Rust authentication module');
        }
        for (const name of names) {
            if (target !== 'win')
                assert.equal((await fs.stat(path.join(directory, name))).mode & 0o7777, 0o755, `Extracted mode: ${name}`);
        }
        const run = (script, args) => execFileSync(process.execPath, [path.join(__dirname, script), ...args], {stdio:'inherit', windowsHide:true});
        run('binary-smoke-test.js', [path.join(directory, names[0]), ...(!converters ? ['--allow-missing-native-jxl'] : []),
            ...(rust && target.startsWith('linux') ? ['--bundled-djxl'] : []),
            ...(rust ? ['--rust'] : []), ...(rust && converters ? ['--require-converters'] : [])]);
        if (converters) {
            if (!rust) run('standalone-pdf-test.js', [directory]);
            run('fb2cng-integration-tests.js', ['--fbc', path.join(directory, names[1])]);
            run('mobi-integration-tests.js', ['--fbc', path.join(directory, names[1]), '--kindling', path.join(directory, names[2])]);
        }
        console.log(`Release ZIP: stored/extracted permissions and real application${converters ? '/EPUB/MOBI' : ''} passed (${target})`);
    } finally { await fs.remove(directory); }
}

module.exports = {checkArchivePermissions, extractArchive};
if (require.main === module) main().catch(error => {console.error(error); process.exitCode = 1;});
