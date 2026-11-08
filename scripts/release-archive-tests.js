const assert = require('assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const {execFileSync} = require('child_process');
const {pipeline} = require('stream/promises');
const {ZipFile} = require('yazl');
const StreamZip = require('node-stream-zip');
const {createReleaseArchive, executableNames} = require('../build/release-archive');
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

module.exports = [testReleaseZipPreservesExecutablesAfterNativeExtraction,testReleaseZipRejectsMissingOrNonExecutablePayload];
