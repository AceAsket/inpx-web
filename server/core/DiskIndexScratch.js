const fs = require('fs-extra');
const path = require('path');

const counted = new Set(['author', 'series', 'title']);
const numeric = new Set(['del', 'librate']);
const runSize = 2048;
const countFields = ['author', 'series', 'title', 'genre', 'lang'];

// Scratch data lives in the private staging directory, never in the selected library.
// SQLite bounds its cache and can sort to disk; the final Jemba format is unchanged.
class DiskIndexScratch {
    static async open(directory) {
        const root = await fs.mkdtemp(path.join(directory, '.index-work-'));
        try {return new this(root);}
        catch (error) {await fs.remove(root); throw error;}
    }

    constructor(root) {
        this.root = root;
        const {DatabaseSync} = require('node:sqlite');
        this.db = new DatabaseSync(path.join(root, 'index.sqlite'));
        const db = this.db;
        try {
            db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; PRAGMA cache_spill=ON");
            db.exec("CREATE TABLE prior(uid TEXT PRIMARY KEY, physical TEXT, legacy TEXT, book INTEGER, hash TEXT, retained INTEGER DEFAULT 0) WITHOUT ROWID;"
                + "CREATE INDEX prior_physical ON prior(physical) WHERE physical != '';"
                + "CREATE INDEX prior_legacy ON prior(physical,legacy) WHERE physical != '' AND legacy != '';"
                + "CREATE TABLE seen(uid TEXT PRIMARY KEY) WITHOUT ROWID;"
                + "CREATE TABLE posts(kind TEXT, value TEXT, book INTEGER, PRIMARY KEY(kind,value,book)) WITHOUT ROWID;"
                + "CREATE TABLE names(id INTEGER PRIMARY KEY, kind TEXT, value TEXT, name TEXT, live INTEGER, deleted INTEGER, UNIQUE(kind,value));"
                + "CREATE INDEX names_order ON names(kind,id);"
                + "CREATE TABLE files(value TEXT PRIMARY KEY, deleted INTEGER) WITHOUT ROWID;"
                + "CREATE TABLE reverse(book INTEGER, entity INTEGER, PRIMARY KEY(book,entity)) WITHOUT ROWID;"
                + "CREATE TABLE runs(run INTEGER, pos INTEGER, nameId INTEGER, PRIMARY KEY(run,pos)) WITHOUT ROWID");
            this.addPrior = db.prepare('INSERT OR REPLACE INTO prior(uid,physical,legacy,book,hash) VALUES (?,?,?,?,?)');
            this.byUid = db.prepare('SELECT uid,physical AS identity,book AS id,hash FROM prior WHERE uid=?');
            this.byLegacy = db.prepare("SELECT uid,physical AS identity,book AS id,hash FROM prior WHERE physical=? AND legacy=? AND physical!='' AND legacy!='' LIMIT 2");
            this.byPhysical = db.prepare("SELECT uid,physical AS identity,book AS id,hash FROM prior WHERE physical=? AND physical!='' LIMIT 2");
            this.retain = db.prepare('UPDATE prior SET retained=1 WHERE uid=?');
            this.hasSeen = db.prepare('SELECT 1 FROM seen WHERE uid=?');
            this.addSeen = db.prepare('INSERT INTO seen VALUES (?)');
            this.addPost = db.prepare('INSERT OR IGNORE INTO posts VALUES (?,?,?)');
            this.addName = db.prepare('INSERT INTO names(kind,value,name,live,deleted) VALUES (?,?,?,?,?) '
                + 'ON CONFLICT(kind,value) DO UPDATE SET live=live+excluded.live, deleted=deleted+excluded.deleted');
            this.hasName = db.prepare('SELECT 1 FROM names WHERE kind=? AND value=?');
            this.addFile = db.prepare('INSERT INTO files VALUES (?,?) ON CONFLICT(value) DO UPDATE SET deleted=min(deleted,excluded.deleted)');
            this.addReverse = db.prepare('INSERT OR IGNORE INTO reverse VALUES (?,?)');
        } catch (error) {db.close(); throw error;}
    }

    batch(work) {
        this.db.exec('BEGIN');
        try {work(); this.db.exec('COMMIT');}
        catch (error) {this.db.exec('ROLLBACK'); throw error;}
    }

    remember(rows) {
        this.batch(() => {
            for (const row of rows)
                this.addPrior.run(row.uid, row.identity || '', row.legacyUid || '', row.id, row.hash ?? null);
        });
    }

    findByUid(uid) {return this.byUid.get(uid);}

    matchArchive(identity, parsedUid) {
        const legacy = this.byLegacy.all(identity, parsedUid);
        if (legacy.length === 1) return legacy[0];
        const rows = this.byPhysical.all(identity);
        return rows.length === 1 ? rows[0] : null;
    }

    knowsPhysical(identity) {return this.byPhysical.get(identity) !== undefined;}
    seen(uid) {return this.hasSeen.get(uid) !== undefined;}
    mark(uid, prior) {
        this.addSeen.run(uid);
        if (prior) this.retain.run(prior.uid);
    }

    *removed() {
        const query = this.db.prepare('SELECT book FROM prior WHERE retained=0');
        for (const row of query.iterate()) yield row.book;
    }

    hasAuthor(value) {return this.hasName.get('author', value) !== undefined;}

    add(kind, fieldValue, book, record, skipEmpty) {
        const name = numeric.has(kind) ? Number(fieldValue) || 0 : String(fieldValue || '?');
        const value = String(name).toLowerCase();
        if (counted.has(kind)) this.addName.run(kind, value, name, record.del ? 0 : 1, record.del ? 1 : 0);
        if (!skipEmpty || fieldValue !== '?') this.addPost.run(kind, value, book);
    }

    file(record) {
        this.addFile.run(record.folder + '/' + record.file + '.' + record.ext, record.del ? 1 : 0);
    }

    counts() {
        const result = {};
        for (const field of countFields) {
            const names = counted.has(field);
            const sql = names ? 'SELECT count(*) AS total FROM names WHERE kind=?' :
                'SELECT count(*) AS total FROM (SELECT DISTINCT value FROM posts WHERE kind=?)';
            result[field] = this.db.prepare(sql).get(field).total;
        }
        return result;
    }

    fileCounts() {
        return this.db.prepare('SELECT count(*) AS total, coalesce(sum(deleted),0) AS deleted FROM files').get();
    }

    // localeCompare determines the numeric IDs used by author/series/title
    // sorting. Sort small runs, then merge them without keeping all names.
    *orderedNames(kind) {
        const db = this.db, compare = (a, b) => a.value.localeCompare(b.value) || a.id - b.id;
        const page = db.prepare('SELECT id,value FROM names WHERE kind=? AND id>? ORDER BY id LIMIT ?');
        const insert = db.prepare('INSERT INTO runs VALUES (?,?,?)');
        const next = db.prepare('SELECT n.id,n.value,n.name,n.live,n.deleted FROM runs r JOIN names n ON n.id=r.nameId WHERE r.run=? AND r.pos=?');
        const queue = [];
        const push = entry => {
            let i = queue.length;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (compare(queue[parent].row, entry.row) <= 0) break;
                queue[i] = queue[parent]; i = parent;
            }
            queue[i] = entry;
        };
        const pop = () => {
            const first = queue[0], last = queue.pop();
            if (queue.length) {
                let i = 0;
                while (2 * i + 1 < queue.length) {
                    let child = 2 * i + 1;
                    if (child + 1 < queue.length && compare(queue[child + 1].row, queue[child].row) < 0) child++;
                    if (compare(last.row, queue[child].row) <= 0) break;
                    queue[i] = queue[child]; i = child;
                }
                queue[i] = last;
            }
            return first;
        };
        let after = 0, run = 0;
        try {
            for (;;) {
                const rows = page.all(kind, after, runSize);
                if (!rows.length) break;
                after = rows.at(-1).id;
                rows.sort(compare);
                this.batch(() => rows.forEach((row, i) => insert.run(run, i, row.id)));
                push({run, pos:0, row:next.get(run, 0)});
                run++;
            }
            while (queue.length) {
                const entry = pop();
                yield entry.row;
                const row = next.get(entry.run, ++entry.pos);
                if (row) push({...entry, row});
            }
        } finally {db.exec('DELETE FROM runs');}
    }

    *rows(kind) {
        const names = counted.has(kind), db = this.db;
        const keys = names ? this.orderedNames(kind) :
            db.prepare('SELECT DISTINCT value FROM posts WHERE kind=? ORDER BY value').iterate(kind);
        const posts = db.prepare('SELECT book FROM posts WHERE kind=? AND value=? ORDER BY book');
        let id = names ? 1 : 0;
        for (const row of keys) {
            const bookIds = [];
            for (const post of posts.iterate(kind, row.value)) bookIds.push(post.book);
            yield {id:id++, value:numeric.has(kind) ? Number(row.value) : row.value, bookIds,
                ...(names ? {name:row.name, bookCount:row.live, bookDelCount:row.deleted} : {})};
        }
    }

    rememberReverse(map, book, entity) {
        const multiple = 0xFFFFFFFF;
        const prior = map[book];
        if (prior === 0) map[book] = entity;
        else {
            if (prior !== multiple) {
                this.addReverse.run(book, prior);
                map[book] = multiple;
            }
            this.addReverse.run(book, entity);
        }
    }

    async saveReverse(file, map) {
        const output = await fs.promises.open(file, 'w');
        try {
            await output.write('{"arr":[');
            for (let i = 0; i < map.length; i += 16384) {
                const chunk = Array.from(map.subarray(i, i + 16384), n => n === 0xFFFFFFFF ? 0 : n);
                await output.write((i ? ',' : '') + chunk.join(','));
            }
            await output.write('],"map":[');
            let last = null, entities = [], buffered = [], written = false;
            const flush = async() => {
                if (!buffered.length) return;
                await output.write((written ? ',' : '') + buffered.join(','));
                buffered = []; written = true;
            };
            for (const row of this.db.prepare('SELECT book,entity FROM reverse ORDER BY book,entity').iterate()) {
                if (row.book !== last) {
                    if (last !== null) buffered.push(JSON.stringify([last, entities]));
                    if (buffered.length >= 2048) await flush();
                    last = row.book; entities = [];
                }
                entities.push(row.entity);
            }
            if (last !== null) buffered.push(JSON.stringify([last, entities]));
            await flush();
            await output.write(']}');
        } finally {await output.close();}
        this.db.exec('DELETE FROM reverse');
    }

    async close() {
        try {this.db.close();}
        finally {await fs.remove(this.root);}
    }
}

module.exports = DiskIndexScratch;
