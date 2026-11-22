const fs = require('fs-extra');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const yazl = require('yazl');

const root = path.resolve(__dirname, '../..');

async function zip(file, entries) {
    const archive = new yazl.ZipFile();
    const done = pipeline(archive.outputStream, fs.createWriteStream(file));
    for (const [name, contents] of Object.entries(entries)) archive.addBuffer(contents, name);
    archive.end();
    await done;
}

async function main() {
    const publicDirectory = path.join(root, 'dist/tmp/public');
    if (!await fs.pathExists(path.join(publicDirectory, 'index.html'))) throw new Error('Build the web client first');
    const assets = path.join(root, 'android/app/src/main/assets');
    await fs.ensureDir(assets);
    const book = title => Buffer.from(`<?xml version="1.0" encoding="utf-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><genre>comp_soft</genre><author><first-name>INPX</first-name><last-name>Rust</last-name></author><book-title>${title}</book-title><lang>ru</lang></title-info><document-info><author><nickname>INPX</nickname></author><date>2026-11-22</date><id>inpx-rust-android-demo</id><version>1.0</version></document-info></description><body><section><title><p>Библиотека работает</p></title><p>Эту книгу обслуживает Rust-сервер на Android.</p></section></body></FictionBook>`);
    const files = {'1.fb2':book('Проверка ZIP на Rust'), '2.fb2':book('Проверка 7z на Rust')};
    const temporary = await fs.mkdtemp(path.join(root, 'dist/android-rust-demo-'));
    const publicEntries = {};
    async function collect(directory, relative = '') {
        for (const entry of await fs.readdir(directory, {withFileTypes:true})) {
            const full = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
            if (entry.isDirectory()) await collect(full, name);
            else if (entry.isFile()) publicEntries[name] = await fs.readFile(full);
        }
    }
    await collect(publicDirectory);
    const publicZip = path.join(temporary, 'public.zip');
    await zip(publicZip, publicEntries);
    const bundle = Buffer.from(JSON.stringify({data:(await fs.readFile(publicZip)).toString('base64')}));
    await zip(path.join(temporary, 'books.zip'), {'1.fb2':files['1.fb2']});
    await fs.writeFile(path.join(temporary, '2.fb2'), files['2.fb2']);
    const sevenZip = process.env.INPX_7Z || (process.platform === 'win32' ? 'C:/Program Files/7-Zip/7z.exe' : '7zz');
    execFileSync(sevenZip, ['a', '-t7z', '-ms=off', 'books.7z', '2.fb2'], {cwd:temporary, stdio:'pipe'});
    const row = (id, ext) => ['Rust,INPX:', 'comp_soft:', `Проверка ${id === 1 ? 'ZIP' : '7z'} на Rust`, '', 0,
        id, files[`${id}.fb2`].length, id, 0, 'fb2', '2026-11-22', 'ru', 0, '', `books.${ext}`].join('\x04');
    await zip(path.join(temporary, 'demo.inpx'), {
        'collection.info':Buffer.from('Android Rust demo'),
        'structure.info':Buffer.from('AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER'),
        'version.info':Buffer.from('20261122'),
        'books.inp':Buffer.from(row(1, 'zip') + '\n' + row(2, '7z') + '\n'),
    });
    const version = require('../../package.json').version;
    const reader = require('../../android/reader.lock.json');
    const native = {};
    for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
        native[abi] = {};
        for (const tool of ['libinpxserver.so', 'libfbc.so', 'libkindling.so', 'libmutool.so']) {
            const contents = await fs.readFile(path.join(root, 'android/app/src/main/jniLibs', abi, tool));
            native[abi][tool] = {bytes:contents.length, sha256:crypto.createHash('sha256').update(contents).digest('hex')};
        }
    }
    const manifest = {runtime:'rust', backendVersion:version, reader, native,
        sourceCommit:execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim()};
    const entries = {'public.json':bundle, 'runtime-manifest.json':Buffer.from(JSON.stringify(manifest))};
    for (const name of ['books.zip', 'books.7z', 'demo.inpx']) entries[`demo/${name}`] = await fs.readFile(path.join(temporary, name));
    const output = path.join(assets, 'runtime.zip');
    await zip(output, entries);
    const sha = crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex');
    await fs.writeFile(path.join(assets, 'runtime.sha256'), sha + '\n');
    console.log(`Rust runtime assets ${version}, ${sha}`);
}

main().catch(error => {console.error(error); process.exitCode = 1;});
