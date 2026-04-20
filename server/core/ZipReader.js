const path = require('path');
const fs = require('fs-extra');
const {spawn} = require('child_process');
const StreamUnzip = require('node-stream-zip');

const sevenZipCommands = (process.platform === 'win32' ? [
    '7z',
    '7za',
    '7zr',
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
] : [
    '7z',
    '7za',
    '7zr',
]);

class ZipReader {
    constructor() {
        this.zip = null;
        this.archiveFile = '';
        this.archiveType = '';
    }

    checkState() {
        if (!this.zip && !this.archiveFile)
            throw new Error('Archive closed');
    }

    run7z(args, outputFile = '') {
        return new Promise((resolve, reject) => {
            let index = 0;

            const tryRun = () => {
                const command = sevenZipCommands[index++];
                const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
                let stderr = '';
                let output = null;
                let settled = false;
                let outputFinished = !outputFile;

                const nextOrReject = (err) => {
                    if (settled)
                        return;
                    settled = true;

                    if (output)
                        output.destroy();

                    if (err && err.code === 'ENOENT' && index < sevenZipCommands.length) {
                        tryRun();
                    } else if (err && err.code === 'ENOENT') {
                        reject(new Error('7z executable not found. Install 7-Zip and make 7z/7za available in PATH.'));
                    } else {
                        reject(err);
                    }
                };

                child.on('error', nextOrReject);

                child.on('spawn', () => {
                    if (outputFile) {
                        output = fs.createWriteStream(outputFile);
                        output.on('error', nextOrReject);
                        output.on('finish', () => {
                            outputFinished = true;
                        });
                        child.stdout.pipe(output);
                    } else {
                        child.stdout.resume();
                    }
                });

                child.stderr.on('data', data => {
                    stderr += data.toString();
                });

                child.on('close', code => {
                    if (settled)
                        return;

                    if (code !== 0) {
                        settled = true;
                        reject(new Error(`7z failed with exit code ${code}: ${stderr.trim()}`));
                        return;
                    }

                    const finish = () => {
                        if (settled)
                            return;
                        settled = true;
                        resolve();
                    };

                    if (!output || outputFinished)
                        finish();
                    else
                        output.on('finish', finish);
                });
            };

            tryRun();
        });
    }

    run7zStdout(args) {
        return new Promise((resolve, reject) => {
            let index = 0;

            const tryRun = () => {
                const command = sevenZipCommands[index++];
                const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
                const stdout = [];
                let stderr = '';
                let settled = false;

                const nextOrReject = (err) => {
                    if (settled)
                        return;
                    settled = true;

                    if (err && err.code === 'ENOENT' && index < sevenZipCommands.length) {
                        tryRun();
                    } else if (err && err.code === 'ENOENT') {
                        reject(new Error('7z executable not found. Install 7-Zip and make 7z/7za available in PATH.'));
                    } else {
                        reject(err);
                    }
                };

                child.on('error', nextOrReject);
                child.stdout.on('data', data => {
                    stdout.push(data);
                });
                child.stderr.on('data', data => {
                    stderr += data.toString();
                });
                child.on('close', code => {
                    if (settled)
                        return;

                    if (code !== 0) {
                        settled = true;
                        reject(new Error(`7z failed with exit code ${code}: ${stderr.trim()}`));
                        return;
                    }

                    settled = true;
                    resolve(Buffer.concat(stdout));
                });
            };

            tryRun();
        });
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
            else if (key === 'Folder')
                entry.isDirectory = value === '+';
        }

        commit();
        return result;
    }

    async open(zipFile, zipEntries = true) {
        if (this.zip || this.archiveFile)
            throw new Error('Archive file is already open');

        if (path.extname(zipFile).toLowerCase() === '.7z') {
            this.archiveFile = zipFile;
            this.archiveType = '7z';
            if (zipEntries) {
                const listing = await this.run7zStdout(['l', '-slt', zipFile]);
                this.zipEntries = this.parse7zEntries(listing.toString());
            }
            return;
        }

        const zip = new StreamUnzip.async({file: zipFile, skipEntryNameValidation: true});

        if (zipEntries)
            this.zipEntries = await zip.entries();

        this.zip = zip;
        this.archiveType = 'zip';
    }

    get entries() {
        this.checkState();

        return this.zipEntries;
    }

    async extractToBuf(entryFilePath) {
        this.checkState();

        if (this.archiveType === '7z')
            return await this.run7zStdout(['x', '-y', '-bd', '-so', this.archiveFile, entryFilePath]);

        return await this.zip.entryData(entryFilePath);
    }

    async extractToFile(entryFilePath, outputFile) {
        this.checkState();

        if (this.archiveType === '7z') {
            await this.run7z(['x', '-y', '-bd', '-so', this.archiveFile, entryFilePath], outputFile);
            return;
        }

        await this.zip.extract(entryFilePath, outputFile);
    }

    async extractAllToDir(outputDir) {
        this.checkState();

        if (this.archiveType === '7z') {
            await this.run7z(['x', '-y', '-bd', `-o${outputDir}`, this.archiveFile]);
            return;
        }

        await this.zip.extract(null, outputDir);
    }

    async close() {
        if (this.zip) {
            await this.zip.close();
            this.zip = null;
        }

        this.archiveFile = '';
        this.archiveType = '';
        this.zipEntries = undefined;
    }
}

module.exports = ZipReader;
