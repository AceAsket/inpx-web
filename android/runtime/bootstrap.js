'use strict';

const fs = require('fs');
const path = require('path');
const nativeDir = process.env.INPX_ANDROID_NATIVE_DIR;
const dataDir = process.env.INPX_ANDROID_DATA_DIR;
process.on('exit', code => {
    try { fs.writeFileSync(path.join(dataDir, '../status.txt'), code === 0 ? 'Сервер остановлен' : `Ошибка: сервер завершился с кодом ${code}. Подробности в журнале.`); } catch {}
});
const addon = {exports: {}};
process.dlopen(addon, path.join(nativeDir, 'libinpxbridge.so'));
const bridge = addon.exports;
const storage = require('./storage-fs').install(bridge);

// 7-Zip inherits the mounted descriptor as fd 3. No archive-sized local copies.
const childProcess = require('child_process');
const spawn = childProcess.spawn;
const children = new Set();
function track(child) { children.add(child); child.once('exit', () => children.delete(child)); return child; }
process.on('exit', () => {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
});
childProcess.spawn = function(command, args, options) {
    const index = args.findIndex(arg => storage.mounted(arg));
    if (index < 0) return track(spawn(command, args, options));
    const fd = storage.open(args[index], 'r');
    try {
        const argv = args.slice(); argv[index] = '/proc/self/fd/3';
        return track(spawn(command, argv, {...options, stdio: ['ignore', 'pipe', 'pipe', fd]}));
    } finally { fs.closeSync(fd); }
};

process.env.TMPDIR = path.join(dataDir, 'tmp');
fs.mkdirSync(process.env.TMPDIR, {recursive: true});
const available = name => fs.existsSync(path.join(nativeDir, name));
const formats = available('libfbc.so') ? ['epub', 'epub3', 'kepub', 'kfx', 'azw8'] : [];
if (formats.length && available('libmutool.so')) formats.push('pdf');
if (formats.length && available('libkindling.so')) formats.push('mobi');
process.env.INPX_ENABLE_CONVERSION = formats.length ? 'true' : 'false';
process.env.INPX_CONVERSION_FORMATS = formats.join(',');
process.env.INPX_MOBI_ENABLED = formats.includes('mobi') ? 'true' : 'false';
const configFile = path.join(dataDir, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
config.converterPaths = {sevenZip: path.join(nativeDir, 'lib7zz.so')};
if (available('libfbc.so')) config.converterPaths.fb2cng = path.join(nativeDir, 'libfbc.so');
if (available('libmutool.so')) config.converterPaths.mutool = path.join(nativeDir, 'libmutool.so');
config.kindlingPath = available('libkindling.so') ? path.join(nativeDir, 'libkindling.so') : '';
config.fb2cngVersion = 'v1.9.0-android'; config.kindlingVersion = 'v0.45.6-android';
// These settings deliberately live in environment configuration in the desktop backend.
process.env.INPX_KINDLING_PATH = config.kindlingPath;
process.env.INPX_KINDLING_VERSION = config.kindlingVersion;
process.env.INPX_FB2CNG_VERSION = config.fb2cngVersion;
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
process.argv = ['node', path.join(__dirname, 'server/index.js'), `--data-dir=${dataDir}`, `--config=${configFile}`];

const stopFile = path.join(dataDir, 'stop');
const stopping = setInterval(() => {
    if (fs.existsSync(stopFile)) {
        clearInterval(stopping);
        fs.unlinkSync(stopFile);
        try { bridge.call('shutdown', ''); } catch {}
        new (require('./server/core/AsyncExit'))().exit(0);
    }
}, 300);
(async() => {
    if (config.librarySources.length === 1 && config.librarySources[0].id === 'demo') {
        await require('./device-checks')(dataDir, config.librarySources[0].libDir);
        const converterRequest = path.join(dataDir, 'converter-checks.request');
        if (fs.existsSync(converterRequest)) {
            fs.unlinkSync(converterRequest);
            await require('./converter-checks')(dataDir, config.librarySources[0].libDir, config);
        }
    }
    require('./server');
})().catch(error => { console.error(error); process.exit(1); });
