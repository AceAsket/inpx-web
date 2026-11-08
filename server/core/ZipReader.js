const path = require('path');
const fs = require('fs-extra');
const {runProcess} = require('./ConversionRuntime');
const StreamUnzip = require('node-stream-zip');
const externalTools = require('./ExternalTools');

class ZipReader {
    constructor(config = {}) {
        this.zip = null;
        this.archiveFile = '';
        this.archiveType = '';
        this.zipNeeds7z = false;
        this.converterPaths = config.converterPaths || null;
        this.maxOutputBytes = config.resourceMaxOutputBytes || 0;
        this.signal = config.resourceSignal;
        this.timeoutMs = config.resourceTimeoutMs;
    }

    get sevenZipCommands() {
        return externalTools.sevenZipCommandCandidates(this.converterPaths);
    }

    get uses7z() {
        // Container format stays ZIP; callers that stream directly must still
        // use this reader when a ZIP entry needs an external decoder.
        return this.archiveType === '7z' || this.zipNeeds7z;
    }

    async zipEntry(name) {
        const entry = await this.zip.entry(name);
        if (!entry || entry.isDirectory)
            throw new Error(`Entry not found: ${name}`);
        return entry;
    }

    externalEntry(entry) {
        // node-stream-zip streams only stored and deflated entries. Select the
        // decoder from metadata; CRC/header errors must never trigger a retry.
        return entry.method !== 0 && entry.method !== 8;
    }

    extractArgs(name) {
        return ['x', '-y', '-bd', '-spd', '-so', '--', this.archiveFile, name];
    }

    checkState() {
        if (!this.zip && !this.archiveFile)
            throw new Error('Archive closed');
    }

    async run7z(args, outputFile = '') {
        return await this.run7zCommand(args, {outputFile});
    }

    async run7zStdout(args) {
        return await this.run7zCommand(args, {captureStdout:true, maxOutputBytes:this.maxOutputBytes});
    }

    async run7zCommand(args, options) {
        for (const command of this.sevenZipCommands) {
            try { return await runProcess(command, args, {...(this.signal ? {signal:this.signal}:{}), ...(this.timeoutMs ? {timeoutMs:this.timeoutMs}:{}), ...options, resourceKind:'reviews'}); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        throw externalTools.createMissingToolError('INPX_MISSING_7Z', externalTools.missingSevenZipMessage());
    }

    parse7zEntries(listing) {
        const result = {};
        let entry = null;
        let index = 0;
        let inEntries = false;

        const commit = () => {
            if (!entry || !entry.name)
                return;

            result[index++] = {
                name: entry.name.replace(/\\/g, '/'),
                isDirectory: !!entry.isDirectory,
                isLink: !!entry.isLink,
                size: entry.size,
            };
        };

        for (const line of listing.split(/\r?\n/)) {
            if (/^-{5,}$/.test(line.trim())) {
                inEntries = true;
                continue;
            }

            if (!inEntries)
                continue;

            if (!line.trim()) {
                commit();
                entry = null;
                continue;
            }

            const match = line.match(/^([^=]+) = (.*)$/);
            if (!match)
                continue;

            const key = match[1].trim();
            const value = match[2];
            entry = entry || {};

            if (key === 'Path')
                entry.name = value;
            else if (key === 'Size')
                entry.size = Number(value);
            else if (key === 'Folder')
                entry.isDirectory = value === '+';
            else if (key === 'Attributes' && /^D/.test(value))
                entry.isDirectory = true;
            if (['Symbolic Link', 'Hard Link'].includes(key) || (key === 'Attributes' && /l[rwx-]{9}/.test(value)))
                entry.isLink = true;
        }

        commit();
        return result;
    }

    async open(zipFile, zipEntries = true) {
        if (this.zip || this.archiveFile)
            throw new Error('Archive file is already open');

        // FLibrary stores recompressed EPUB containers with an .epub name;
        // extracted books also have extensionless temporary names.
        const handle = await fs.promises.open(zipFile, 'r');
        const signature = Buffer.alloc(6);
        try {
            await handle.read(signature, 0, signature.length, 0);
        } finally {
            await handle.close();
        }
        if (signature.equals(Buffer.from('377abcaf271c', 'hex')) || path.extname(zipFile).toLowerCase() === '.7z') {
            this.archiveFile = zipFile;
            this.archiveType = '7z';
            if (zipEntries) {
                const listing = await this.run7zStdout(['l', '-slt', '-sccUTF-8', zipFile]);
                this.zipEntries = this.parse7zEntries(listing.toString());
            }
            return;
        }

        const zip = new StreamUnzip.async({file: zipFile, skipEntryNameValidation: true});

        this.zip = zip;
        this.archiveFile = zipFile;
        this.archiveType = 'zip';
        try {
            const entries = await zip.entries();
            this.zipNeeds7z = Object.values(entries).some(entry => !entry.isDirectory && this.externalEntry(entry));
            if (zipEntries)
                this.zipEntries = entries;
        } catch (error) {
            await this.close().catch(() => {});
            throw error;
        }
    }

    get entries() {
        this.checkState();

        return this.zipEntries;
    }

    async extractToBuf(entryFilePath) {
        this.checkState();
        this.signal?.throwIfAborted();

        if (this.archiveType === '7z')
            return await this.run7zStdout(this.extractArgs(entryFilePath));

        const entry = await this.zipEntry(entryFilePath);
        if (this.maxOutputBytes > 0 && Number(entry.size) > this.maxOutputBytes)
            throw Object.assign(new Error('Превышен размер извлечённого файла'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
        if (this.externalEntry(entry))
            return await this.run7zStdout(this.extractArgs(entryFilePath));

        if (this.maxOutputBytes > 0) {
            const oversized = () => Object.assign(new Error('Превышен размер извлечённого файла'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
            const stream = await this.zip.stream(entryFilePath), chunks = [];
            let bytes = 0;
            try {
                for await (const chunk of stream) {
                    bytes += chunk.length;
                    if (bytes > this.maxOutputBytes) throw oversized();
                    chunks.push(chunk);
                }
            } finally {stream.destroy();}
            return Buffer.concat(chunks, bytes);
        }
        return await this.zip.entryData(entryFilePath);
    }

    async extractPrefixToBuf(entryFilePath, maximum) {
        this.checkState();
        if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid archive prefix limit');
        this.signal?.throwIfAborted();
        if (this.archiveType === '7z')
            return await this.run7zCommand(this.extractArgs(entryFilePath),{captureStdout:true,capturePrefixBytes:maximum});
        const entry = await this.zipEntry(entryFilePath);
        if (this.externalEntry(entry))
            return await this.run7zCommand(this.extractArgs(entryFilePath),{captureStdout:true,capturePrefixBytes:maximum});
        const stream = await this.zip.stream(entryFilePath), chunks=[];
        let bytes=0;
        const abort=()=>stream.destroy(this.signal.reason || Object.assign(new Error('Preview cancelled'),{code:'ABORT_ERR'}));
        this.signal?.addEventListener('abort',abort,{once:true});
        try {
            this.signal?.throwIfAborted();
            for await (const chunk of stream) {
                const part=chunk.subarray(0,maximum-bytes);chunks.push(part);bytes+=part.length;
                if (bytes>=maximum) break;
            }
        } finally {this.signal?.removeEventListener('abort',abort);stream.destroy();}
        return Buffer.concat(chunks,bytes);
    }

    async extractToFile(entryFilePath, outputFile) {
        this.checkState();
        this.signal?.throwIfAborted();

        const entry = this.archiveType === 'zip' ? await this.zipEntry(entryFilePath) : null;
        if (this.maxOutputBytes > 0 && Number(entry?.size) > this.maxOutputBytes)
            throw Object.assign(new Error('Превышен размер извлечённого файла'), {code:'INPX_RESOURCE_OUTPUT_LIMIT'});
        if (this.archiveType === '7z' || this.externalEntry(entry)) {
            try {
                await this.run7zCommand(this.extractArgs(entryFilePath), {outputFile, maxOutputBytes:this.maxOutputBytes});
            } catch (error) {
                await fs.remove(outputFile);
                throw error;
            }
            return;
        }

        await this.zip.extract(entryFilePath, outputFile);
    }

    async extractAllToDir(outputDir) {
        this.checkState();

        if (this.uses7z) {
            await this.run7z(['x', '-y', '-bd', `-o${outputDir}`, this.archiveFile]);
            return;
        }

        await this.zip.extract(null, outputDir);
    }

    async close() {
        try {
            if (this.zip) await this.zip.close();
        } finally {
            this.zip = null;
            this.archiveFile = '';
            this.archiveType = '';
            this.zipNeeds7z = false;
            this.zipEntries = undefined;
        }
    }
}

module.exports = ZipReader;
