'use strict';

const fs = require('fs');
const path = require('path');
const {fileURLToPath} = require('url');
const {Readable} = require('stream');
const PREFIX = '/__android_library__/';

// Install before fs-extra/graceful-fs captures fs methods. All writes remain on real local storage.
function install(bridge) {
    const original = {};
    for (const name of ['open', 'openSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'readdir', 'readdirSync', 'realpath', 'realpathSync', 'readFile', 'readFileSync', 'createReadStream', 'exists', 'existsSync'])
        original[name] = fs[name];
    const pathname = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
    const mounted = value => typeof pathname(value) === 'string' && pathname(value).startsWith(PREFIX);
    function call(op, file) {
        const p = pathname(file);
        const relative = p.slice(PREFIX.length);
        if (relative.split('/').some(part => part === '..' || part === '.' || part.includes('\\') || part.includes('\0'))) {
            const error = new Error('Invalid library path'); error.code = 'EACCES'; throw error;
        }
        const result = JSON.parse(bridge.call(op, p));
        if (result.error) {
            const error = new Error(`${result.error}: ${result.message}, ${op} '${p}'`);
            error.code = result.error; error.path = p; error.syscall = op; throw error;
        }
        return result.value;
    }
    function stat(file, options) {
        const value = call('stat', file);
        const n = v => options?.bigint ? BigInt(Math.trunc(v)) : v;
        const result = {
            size: n(value.size), mode: n(value.directory ? 0o40555 : 0o100444),
            mtimeMs: n(value.modified), ctimeMs: n(value.modified), atimeMs: n(value.modified), birthtimeMs: n(value.modified),
            mtime: new Date(value.modified), ctime: new Date(value.modified), atime: new Date(value.modified), birthtime: new Date(value.modified),
            isDirectory: () => value.directory, isFile: () => !value.directory,
            isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
            isFIFO: () => false, isSocket: () => false,
        };
        for (const key of ['dev', 'ino', 'nlink', 'uid', 'gid', 'rdev', 'blksize', 'blocks']) result[key] = n(0);
        return result;
    }
    function open(file, flags) {
        if (flags !== 'r' && flags !== fs.constants.O_RDONLY) {
            const e = new Error('Library mounts are read-only'); e.code = 'EROFS'; throw e;
        }
        return call('open', file);
    }
    function access(file, mode = fs.constants.F_OK) {
        if (mode & (fs.constants.W_OK | fs.constants.X_OK)) { const e = new Error('Library mounts are read-only'); e.code = 'EACCES'; throw e; }
        call('stat', file);
    }
    function readdir(file, options) {
        if (typeof options === 'string') options = {encoding: options};
        const encode = name => options?.encoding === 'buffer' ? Buffer.from(name) : name;
        return call('list', file).map(entry => options?.withFileTypes ? {
            name: encode(entry.name), parentPath: pathname(file), path: pathname(file),
            isDirectory: () => entry.directory, isFile: () => !entry.directory, isSymbolicLink: () => false,
            isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
        } : encode(entry.name));
    }
    const sync = {open, stat, lstat: stat, access, readdir, realpath: file => { call('stat', file); return pathname(file); }};
    for (const [name, fn] of Object.entries(sync)) {
        fs[`${name}Sync`] = function(file, ...args) { return mounted(file) ? fn(file, ...args) : original[`${name}Sync`](file, ...args); };
        fs[name] = function(file, ...args) {
            if (!mounted(file)) return original[name](file, ...args);
            const callback = args.pop();
            process.nextTick(() => { let result; try { result = fn(file, ...args); } catch (error) { callback(error); return; } callback(null, result); });
        };
    }
    fs.realpath.native = fs.realpath;
    fs.realpathSync.native = fs.realpathSync;
    fs.existsSync = file => mounted(file) ? (() => { try { call('stat', file); return true; } catch { return false; } })() : original.existsSync(file);
    fs.exists = (file, callback) => mounted(file) ? process.nextTick(() => callback(fs.existsSync(file))) : original.exists(file, callback);
    fs.readFile = function(file, options, callback) {
        if (!mounted(file)) return original.readFile(file, options, callback);
        if (typeof options === 'function') { callback = options; options = undefined; }
        fs.open(file, 'r', (error, fd) => {
            if (error) return callback(error);
            original.readFile(fd, options, (readError, result) => fs.close(fd, closeError => callback(readError || closeError, result)));
        });
    };
    fs.readFileSync = function(file, options) {
        if (!mounted(file)) return original.readFileSync(file, options);
        const fd = open(file, 'r');
        try { return original.readFileSync(fd, options); } finally { fs.closeSync(fd); }
    };
    fs.createReadStream = function(file, options = {}) {
        if (!mounted(file)) return original.createReadStream(file, options);
        if (typeof options === 'string') options = {encoding: options};
        try { return original.createReadStream(null, {...options, fd: open(file, options.flags || 'r'), autoClose: true}); }
        catch (error) { const stream = new Readable({read() {}}); process.nextTick(() => stream.destroy(error)); return stream; }
    };
    // fs.promises bypasses exported callback methods in Node itself.
    for (const name of ['stat', 'lstat', 'access', 'readdir', 'realpath', 'readFile']) {
        const previous = fs.promises[name].bind(fs.promises);
        fs.promises[name] = function(file, ...args) {
            if (!mounted(file)) return previous(file, ...args);
            return new Promise((resolve, reject) => fs[name](file, ...args, (e, value) => e ? reject(e) : resolve(value)));
        };
    }
    const previousOpen = fs.promises.open.bind(fs.promises);
    fs.promises.open = async function(file, flags = 'r', mode) {
        if (!mounted(file)) return previousOpen(file, flags, mode);
        const fd = open(file, flags);
        // Android proxy FDs cannot be reopened through /proc (EACCES). Keep the granted descriptor.
        let closed = false;
        const handle = {
            fd,
            read(buffer, offset = 0, length = buffer.byteLength, position = null) {
                if (typeof offset === 'object') ({offset = 0, length = buffer.byteLength - offset, position = null} = offset);
                return new Promise((resolve, reject) => fs.read(fd, buffer, offset, length, position, (error, bytesRead, data) => error ? reject(error) : resolve({bytesRead, buffer: data})));
            },
            stat(options) { return new Promise((resolve, reject) => fs.fstat(fd, options, (e, result) => e ? reject(e) : resolve(result))); },
            readFile(options) { return new Promise((resolve, reject) => original.readFile(fd, options, (e, result) => e ? reject(e) : resolve(result))); },
            async close() {
                if (closed) return; closed = true;
                await new Promise((resolve, reject) => fs.close(fd, e => e ? reject(e) : resolve()));
            },
        };
        handle[Symbol.asyncDispose] = handle.close;
        return handle;
    };
    return {mounted, open, original};
}

module.exports = {install, PREFIX};
