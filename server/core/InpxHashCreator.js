const fs = require('fs-extra');

const utils = require('./utils');
const {getEnabledLibrarySources} = require('./LibrarySources');

class InpxHashCreator {
    constructor(config) {
        this.config = config;
    }

    async getHash() {
        const config = this.config;

        let inpxFilterHash = '';
        if (await fs.pathExists(config.inpxFilterFile))
            inpxFilterHash = await utils.getFileHash(config.inpxFilterFile, 'sha256', 'hex');

        const sourceHashes = [];
        for (const source of getEnabledLibrarySources(config)) {
            const inpxFile = source.inpxFile || source.inpx;
            sourceHashes.push([
                source.id,
                source.name,
                source.libDir,
                await utils.getFileHash(inpxFile, 'sha256', 'hex'),
            ].join(':'));
        }

        const joinedHash = this.config.dbVersion + inpxFilterHash + sourceHashes.join('|');

        return utils.getBufHash(joinedHash, 'sha256', 'hex');
    }

    async getInpxFileHash() {
        return (
            await fs.pathExists(this.config.inpxFile) ?
            await utils.getFileHash(this.config.inpxFile, 'sha256', 'hex') :
            ''
        );
    }
}

module.exports = InpxHashCreator;
