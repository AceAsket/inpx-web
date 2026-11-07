const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {writeFileAtomic} = require('./FilePersistence');

const maximumImageBytes = 4 * 1024 ** 2;
const types = {png:'image/png', jpg:'image/jpeg', gif:'image/gif', webp:'image/webp'};
const assetName = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const settings = preferences => [preferences, preferences?.einkProfile].filter(value => value && typeof value === 'object');

class ReaderAssets {
    constructor(config) {this.config = config; this.directory = path.join(config.dataDir, 'reader-backgrounds');}

    reference(value, userId) {
        const match = String(value || '').match(/(?:^|\/)reader-background\/([^/]+)\/([a-f0-9]{64}\.(?:png|jpg|gif|webp))$/);
        if (!match) return null;
        try {return decodeURIComponent(match[1]) === String(userId) ? match[2] : null;} catch {return null;}
    }

    url(userId, name) {
        const root = String(this.config.rootPathStatic ?? this.config.server?.root ?? '').replace(/\/$/, '');
        return `${root}/reader-background/${encodeURIComponent(userId)}/${name}`;
    }

    async destination(userId, name, create = false) {
        if (!assetName.test(name)) throw new Error('Некорректный файл фона');
        if (create) await fs.ensureDir(this.directory, {mode:0o700});
        const directory = await fs.lstat(this.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Небезопасный каталог фонов');
        const file = path.join(this.directory, `${digest(String(userId))}-${name}`);
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Небезопасный файл фона');
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
        return file;
    }

    async externalize(data) {
        let changed = false;
        for (const user of Array.isArray(data?.users) ? data.users : []) {
            if (!user?.id) continue;
            for (const value of settings(user.readerPreferences)) {
                const image = String(value.backgroundImage || '');
                let name = this.reference(image, user.id);
                if (/^data:image\//i.test(image)) {
                    // Older readers accepted SVG/AVIF/BMP. Preserve those inline
                    // rather than serving active SVG on the application's origin.
                    if (!/^data:image\/(png|jpe?g|gif|webp);/i.test(image)) continue;
                    const match = image.match(/^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/]*={0,2})$/i);
                    if (!match || match[2].length % 4 || match[2].length > Math.ceil(maximumImageBytes / 3) * 4)
                        throw new Error('Фон должен быть PNG, JPEG, GIF или WebP размером до 4 МиБ');
                    const buffer = Buffer.from(match[2], 'base64');
                    if (!buffer.length || buffer.length > maximumImageBytes) throw new Error('Превышен размер фона');
                    const extension = /^jpe?g$/i.test(match[1]) ? 'jpg' : match[1].toLowerCase();
                    name = `${digest(buffer)}.${extension}`;
                    const file = await this.destination(user.id, name, true);
                    if (!await fs.pathExists(file)) await writeFileAtomic(file, buffer);
                }
                if (name && image !== this.url(user.id, name)) {
                    value.backgroundImage = this.url(user.id, name); changed = true;
                }
            }
        }
        return changed;
    }

    async inlinePreferences(userId, preferences) {
        const result = structuredClone(preferences || {});
        for (const value of settings(result)) {
            const name = this.reference(value.backgroundImage, userId);
            if (!name) continue;
            const buffer = await fs.readFile(await this.destination(userId, name));
            if (buffer.length > maximumImageBytes || digest(buffer) !== name.split('.')[0]) throw new Error('Файл фона повреждён');
            value.backgroundImage = `data:${types[path.extname(name).slice(1)]};base64,${buffer.toString('base64')}`;
        }
        return result;
    }

    references(data) {
        const result = new Set();
        for (const user of Array.isArray(data?.users) ? data.users : []) for (const value of settings(user.readerPreferences)) {
            const name = this.reference(value.backgroundImage, user.id);
            if (name) result.add(`${digest(String(user.id))}-${name}`);
        }
        return result;
    }

    async prune(data) {
        const used = this.references(data);
        const signature = [...used].sort().join('|');
        const now = Date.now();
        if (signature === this.lastReferences && now - this.lastScanAt < 3600000) return;
        let entries;
        try {
            const directory = await fs.lstat(this.directory);
            if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Небезопасный каталог фонов');
            entries = await fs.readdir(this.directory);
        } catch (error) {
            if (error.code === 'ENOENT') {this.lastReferences = signature; this.lastScanAt = now; return;}
            throw error;
        }
        const unused = [];
        let bytes = 0;
        for (const name of entries) {
            if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(name) || used.has(name)) continue;
            const file = path.join(this.directory, name), stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) continue;
            unused.push({file, bytes:stat.size, at:stat.mtimeMs}); bytes += stat.size;
        }
        for (const row of unused.sort((a,b) => a.at - b.at)) {
            if (now - row.at < 86400000 && bytes <= 64 * 1024 ** 2) continue;
            await fs.remove(row.file); bytes -= row.bytes;
        }
        this.lastReferences = signature; this.lastScanAt = now;
    }
}

function register(app, config, worker, security) {
    const root = String(config.rootPathStatic || '').replace(/\/$/, '');
    app.get(`${root}/reader-background/:userId/:name`, async(req, res, next) => {
        try {
            const access = typeof req.query.access === 'string' ? req.query.access : '';
            const identity = await new (require('./ProfileAccess'))(config, worker, security).resolve(req, access);
            let user = identity?.user;
            if (!user && config.allowAnonymousAccess !== false && req.params.userId === 'default') {
                const guest = await worker.readingListStore.getUser('default');
                if (guest.id === 'default' && !guest.isAdmin && !guest.login && !guest.passwordHash) user = guest;
            }
            if (!user || user.id !== req.params.userId) return res.sendStatus(user ? 403 : 401);
            const assets = worker.readingListStore.assets;
            if (!settings(user.readerPreferences).some(value => assets.reference(value.backgroundImage, user.id) === req.params.name))
                return res.sendStatus(404);
            const file = await assets.destination(user.id, req.params.name);
            res.set({'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff'});
            res.type(types[path.extname(req.params.name).slice(1)]).sendFile(file);
        } catch (error) {
            if (error.code === 'ENOENT') return res.sendStatus(404);
            next(error);
        }
    });
}

module.exports = {ReaderAssets, register, maximumImageBytes};
