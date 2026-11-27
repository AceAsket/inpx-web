const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');
const StreamZip = require('node-stream-zip');
const {createReleaseArchive, executableNames, rustProgramEntry} = require('../build/release-archive');
const {checkArchivePermissions, extractArchive} = require('./release-archive-smoke-test');

async function temporary(work) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-release-zip-'));
    try {await work(dir);} finally {await fs.remove(dir);}
}

async function testReleaseZipPreservesExecutablesAfterNativeExtraction() {
    await temporary(async dir => {
        const source = path.join(dir, 'source files'), archive = path.join(dir, 'release files.zip');
        for (const name of executableNames('linux')) {
            const file = path.join(source, name);
            await fs.outputFile(file, '#!/bin/sh\nprintf "release fixture\\n"\n');
            await fs.chmod(file, 0o644); // Reproduce files copied without +x.
        }
        await fs.outputFile(path.join(source, 'docs/Книга.txt'), 'unchanged UTF-8 metadata');
        await fs.outputFile(path.join(source, '.settings'), 'hidden file');
        await fs.ensureDir(path.join(source, 'empty'));
        for (const target of ['linux','linux-arm64','macos']) {
            await createReleaseArchive(source, archive, target);
            await checkArchivePermissions(archive, target);
        }
        const zip = new StreamZip.async({file:archive});
        try {
            const entries = await zip.entries();
            assert.equal((entries['docs/Книга.txt'].attr >>> 16) & 0o777, 0o644);
            assert.equal((entries['empty/'].attr >>> 16) & 0o777, 0o755);
            assert.equal((await zip.entryData('.settings')).toString(), 'hidden file');
        } finally {await zip.close();}
        const extracted = path.join(dir, 'extracted files');await fs.ensureDir(extracted);
        await extractArchive(archive, extracted);
        assert.equal(await fs.readFile(path.join(extracted,'docs/Книга.txt'),'utf8'), 'unchanged UTF-8 metadata');
        if (process.platform !== 'win32') {
            for (const name of executableNames('linux')) {
                const file = path.join(extracted, name);
                assert.equal((await fs.stat(file)).mode & 0o7777, 0o755);
                assert.equal(execFileSync(file, [], {encoding:'utf8'}), 'release fixture\n');
            }
        }
        assert.equal((await fs.stat(path.join(source,'inpx-web'))).mode & 0o111, 0, 'Packing does not chmod the source');
        const windows = path.join(dir,'windows');
        for (const name of executableNames('win')) await fs.outputFile(path.join(windows,name),'windows payload');
        await createReleaseArchive(windows,archive,'win');
        await checkArchivePermissions(archive,'win');
    });
}

async function testReleaseZipRejectsMissingOrNonExecutablePayload() {
    await temporary(async dir => {
        const archive = path.join(dir,'legacy.zip');
        for (const broken of executableNames('linux')) {
            const zip = new ZipFile(), writing = pipeline(zip.outputStream,fs.createWriteStream(archive));
            for (const name of executableNames('linux')) zip.addBuffer(Buffer.from('payload'),name,{mode:name === broken ? 0o100644 : 0o100755});
            zip.end();await writing;
            await assert.rejects(checkArchivePermissions(archive,'linux'),error => error.message.includes(broken) && error.message.includes('755'));
        }
        await assert.rejects(createReleaseArchive(dir,path.join(dir,'missing.zip'),'linux'),{code:'ENOENT'});
    });
}

async function testIncompleteStandaloneConverterBundlesAreRejected() {
    await temporary(async dir => {
        for (const target of ['linux', 'linux-arm64', 'macos', 'win']) {
            const source = path.join(dir, target);
            const archive = path.join(dir, target + '.zip');
            const programs = executableNames(target);
            const files = [...programs, 'bin/public.json', 'bin/LICENSE.quickjs', 'bin/LICENSE.kindling',
                'bin/LICENSE.mupdf', 'bin/mupdf-source.txt', 'bin/mupdf-third-party.rst'];
            if (target.startsWith('linux')) files.push('bin/djxl', 'bin/djxl-licenses/LICENSE.jpeg-xl');
            if (target === 'win') files.push('bin/7za.exe', 'bin/djxl.exe', 'bin/dwebp.exe', 'vcruntime140.dll', 'bin/vcruntime140.dll');
            for (const name of files) await fs.outputFile(path.join(source, name), 'payload');
            await createReleaseArchive(source, archive, target);
            await checkArchivePermissions(archive, target, true, true);

            const extraTool = rustProgramEntry(target, 'catalog');
            await fs.outputFile(path.join(source, extraTool), 'payload');
            await createReleaseArchive(source, archive, target);
            await assert.rejects(checkArchivePermissions(archive, target, true, true),
                error => error.message.includes(extraTool), target + ' must reject a separate Rust executable');
            await fs.unlink(path.join(source, extraTool));

            for (const name of [...programs.slice(1), 'bin/LICENSE.kindling', 'bin/LICENSE.mupdf']) {
                const file = path.join(source, name);
                await fs.unlink(file);
                await createReleaseArchive(source, archive, target);
                await assert.rejects(checkArchivePermissions(archive, target, true, true),
                    error => error.message.includes(name), target + ' must reject a missing ' + name);
                await fs.outputFile(file, 'payload');
            }
        }
    });
}

async function testRustPrepackagingNeedsOnlyTheServerBinary() {
    await temporary(async dir => {
        const dist = path.join(dir, 'dist');
        const server = path.join(dir, 'inpx-server');
        const output = path.join(dist, 'linux');
        await fs.outputFile(server, 'standalone server');
        await fs.outputFile(path.join(dist, 'tmp/public/index.html'), '<html></html>');
        for (const program of ['catalog', 'reader'])
            await fs.outputFile(path.join(output, rustProgramEntry('linux', program)), 'old tool');

        execFileSync(process.execPath, [path.resolve(__dirname, '../build/prepkg.js'), 'linux', '--rust'], {
            windowsHide: true,
            env: {...process.env, INPX_BUILD_DIST_DIR: dist, INPX_RUST_SERVER_BINARY: server,
                INPX_RUST_CATALOG_BINARY: path.join(dir, 'missing-catalog'),
                INPX_RUST_READER_BINARY: path.join(dir, 'missing-reader')},
        });
        assert.equal(await fs.readFile(path.join(output, 'inpx-web'), 'utf8'), 'standalone server');
        assert.deepEqual((await fs.readdir(path.join(output, 'bin'))).sort(), ['LICENSE.quickjs', 'public.json']);
    });
}

module.exports = [testReleaseZipPreservesExecutablesAfterNativeExtraction,testReleaseZipRejectsMissingOrNonExecutablePayload,
    testIncompleteStandaloneConverterBundlesAreRejected, testRustPrepackagingNeedsOnlyTheServerBinary];
