const fs = require('fs-extra');
const path = require('path');
const utils = require('./utils');

const FileDownloader = require('./FileDownloader');
const WebSocketConnection = require('./WebSocketConnection');
const InpxHashCreator = require('./InpxHashCreator');
const log = new (require('./AppLogger'))().log;//singleton

//singleton
let instance = null;

function bookUrl(origin, basePath, value) {
    const link = String(value || '');
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(link);
    const url = new URL(link.startsWith('/') || absolute ? link : `${basePath}/${link}`, origin);
    const hash = path.posix.basename(url.pathname);
    if (!link || url.origin !== origin || url.username || url.password || !/^[a-f0-9]+$/i.test(hash))
        throw new Error('Некорректная ссылка удалённой книги');
    return {url:url.href, hash};
}

class RemoteLib {
    constructor(config) {
        if (!instance) {
            this.config = config;

            this.wsc = new WebSocketConnection(config.remoteLib.url, 10, 30, {rejectUnauthorized: false});

            const address = new URL(config.remoteLib.url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://'));
            this.remoteHost = address.origin;
            this.remoteBasePath = address.pathname.replace(/\/$/, '');
            this.metadata = new (require('./RemoteMetadata'))(this);

            this.down = new FileDownloader(config.maxPayloadSize*1024*1024);
            this.inpxHashCreator = new InpxHashCreator(config);
            this.inpxFileHash = '';

            instance = this;
        }

        return instance;
    }

    async ensureConnection() {
        this.metadata.setConnection(await this.wsc._open());
    }

    async wsRequest(query, recurse = false) {
        await this.ensureConnection();
        if (this.accessToken)
            query.accessToken = this.accessToken;

        const response = await this.wsc.message(
            await this.wsc.send(query),
            120
        );
        this.metadata.setConnection(this.wsc.ws);

        if (!recurse && response && response.error == 'need_access_token' && this.config.remoteLib.accessPassword) {
            this.accessToken = utils.getBufHash(this.config.remoteLib.accessPassword + response.salt, 'sha256', 'hex');
            return await this.wsRequest(query, true);
        }

        if (response.error)
            throw new Error(response.error);

        return response;
    }

    async downloadInpxFile() {
        await this.metadata.supported();
        if (!this.inpxFileHash)
            this.inpxFileHash = await this.inpxHashCreator.getInpxFileHash();

        const response = await this.wsRequest({action: 'get-inpx-file', inpxFileHash: this.inpxFileHash});

        if (response.data) {
            await fs.writeFile(this.config.inpxFile, response.data, 'base64');
            this.inpxFileHash = '';
        }
    }

    async downloadBook(bookUid) {
        try {
            const response = await this.wsRequest({action: 'get-book-link', bookUid});
            const link = response.link;

            const {url, hash} = bookUrl(this.remoteHost, this.remoteBasePath, link);
            const buf = await this.down.load(url, {decompress: false});
            const publicPath = `${this.config.bookDir}/${hash}`;
            
            await utils.prepareCachedFile(publicPath, file => fs.writeFile(file, buf));

            return hash;
        } catch (e) {
            log(LM_ERR, `RemoteLib.downloadBook: ${e.message}`);
            throw new Error('502 Bad Gateway');
        }
    }
}

module.exports = RemoteLib;
module.exports.bookUrl = bookUrl;
