'use strict';

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const yazl = require('yazl');
const root = path.resolve(__dirname, '../..');
const assets = path.join(root, 'android/app/src/main/assets');

async function zip(file, entries) {
    const archive = new yazl.ZipFile();
    const done = new Promise((resolve, reject) => archive.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject));
    for (const [name, data] of Object.entries(entries)) archive.addBuffer(Buffer.from(data), name);
    archive.end(); await done;
}
async function main() {
    await fs.ensureDir(assets);
    const stage = path.join(root, 'dist/android-runtime');
    // This generated directory is always inside dist; never touch the user's libraries.
    await fs.emptyDir(stage);
    for (const dir of ['server', 'shared']) await fs.copy(path.join(root, dir), path.join(stage, dir), {
        filter: file => !path.relative(path.join(root, dir), file).split(path.sep).some(p => p.startsWith('.inpx-web')),
    });
    await fs.writeFile(path.join(stage, 'server/config/application_env'), 'production');
    await fs.copy(path.join(root, 'android/runtime'), stage);
    await fs.copy(path.join(root, 'package.json'), path.join(stage, 'package.json'));
    await fs.copy(path.join(root, 'build/appdir.js'), path.join(stage, 'build/appdir.js'));
    const publicDir = path.join(root, 'dist/tmp/public');
    if (!await fs.pathExists(path.join(publicDir, 'index.html'))) throw new Error('Run npm run build:client first');
    const publicEntries = {};
    async function files(dir, callback, relative = '') {
        for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
            const rel = path.posix.join(relative, entry.name), full = path.join(dir, entry.name);
            if (entry.isDirectory()) await files(full, callback, rel); else if (entry.isFile()) await callback(full, rel);
        }
    }
    await files(publicDir, async(file, rel) => { publicEntries[rel] = await fs.readFile(file); });
    const publicZip = path.join(stage, 'public.zip'); await zip(publicZip, publicEntries);
    await fs.outputJson(path.join(stage, 'dist/public.json'), {data: (await fs.readFile(publicZip)).toString('base64')});
    await fs.remove(publicZip);

    // Copy only backend dependency trees. Resolve from the installed lockfile tree, including nested versions.
    const pending = ['axios', 'chardet', 'dayjs', 'express', 'express-basic-auth', 'form-data', 'fs-extra', 'he', 'iconv-lite', 'jembadb', 'lodash', 'minimist', 'node-stream-zip', 'nodemailer', 'safe-buffer', 'ws', 'yazl', 'js-yaml'].map(name => [name, root]);
    const copied = new Set();
    while (pending.length) {
        const [name, from] = pending.pop();
        let location;
        try { location = require.resolve(`${name}/package.json`, {paths: [from]}); }
        catch {
            location = require.resolve(name, {paths: [from]});
            while (!await fs.pathExists(path.join(path.dirname(location), 'package.json'))) location = path.dirname(location);
            location = path.join(path.dirname(location), 'package.json');
        }
        const directory = path.dirname(location);
        if (copied.has(directory)) continue; copied.add(directory);
        const relative = path.relative(root, directory);
        if (relative.startsWith('..') || !relative.startsWith('node_modules')) throw new Error(`Dependency outside workspace: ${name}`);
        await fs.copy(directory, path.join(stage, relative), {filter: file => !path.relative(directory, file).split(path.sep).some(p => ['node_modules', 'test', 'tests', '.git', 'coverage'].includes(p))});
        const pkg = await fs.readJson(location);
        for (const dependency of Object.keys(pkg.dependencies || {})) pending.push([dependency, directory]);
    }
    const demo = path.join(stage, 'demo'); await fs.ensureDir(demo);
    const book = n => `<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>comp_soft</genre><author><first-name>INPX</first-name><last-name>Android</last-name></author><book-title>Проверка ${n === 1 ? 'ZIP' : '7z'} на Android</book-title><lang>ru</lang></title-info><document-info><author><nickname>INPX</nickname></author><date>2026-10-28</date><id>inpx-android-demo-${n}</id><version>1.0</version></document-info></description><body><section><title><p>Библиотека работает</p></title><p>Эта книга создана для проверки сервера на Android. Каталог, извлечение архива и читалка работают на устройстве.</p>${'<p>Проверка чтения и перелистывания страниц.</p>'.repeat(60)}</section></body></FictionBook>`;
    await zip(path.join(demo, 'zip-books.zip'), {'1.fb2': book(1)});
    const sevenZip = process.env.INPX_7Z || (process.platform === 'win32' ? 'C:/Program Files/7-Zip/7z.exe' : '7zz');
    await fs.writeFile(path.join(demo, '2.fb2'), book(2));
    execFileSync(sevenZip, ['a', '-t7z', '-ms=off', path.join(demo, 'seven-books.7z'), '2.fb2'], {cwd: demo, stdio: 'pipe'});
    await fs.remove(path.join(demo, '2.fb2'));
    const row = n => ['Android,INPX:', 'comp_soft:', `Проверка ${n === 1 ? 'ZIP' : '7z'} на Android`, '', '0', String(n), String(Buffer.byteLength(book(n))), String(n), '0', 'fb2', '2026-10-28', 'ru', '0', '', n === 1 ? 'zip-books.zip' : 'seven-books.7z'].join('\x04');
    await zip(path.join(demo, 'demo.inpx'), {'collection.info': 'Android demo', 'version.info': '20261028', 'structure.info': 'AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER', 'books.inp': row(1) + '\n' + row(2) + '\n'});
    const archive = new yazl.ZipFile();
    const output = path.join(assets, 'runtime.zip');
    const done = new Promise((resolve, reject) => archive.outputStream.pipe(fs.createWriteStream(output)).on('close', resolve).on('error', reject));
    await files(stage, async(file, rel) => archive.addFile(file, rel)); archive.end(); await done;
    const digest = crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex');
    await fs.writeFile(path.join(assets, 'runtime.sha256'), digest + '\n');
    console.log(`Android runtime: ${copied.size} backend packages, ${(await fs.stat(output)).size} bytes, SHA256 ${digest}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
