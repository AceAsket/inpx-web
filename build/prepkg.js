const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');

const MarkdownIt = require('markdown-it');
const {fileName: authStateFile} = require('../server/core/RustAuthState');
const {executableNames, rustProgramEntry} = require('./release-archive');

const args = process.argv.slice(2);
const native = args.includes('--rust');
const platform = args.find(value => value !== '--rust');

const distDir = require('./dist-dir');
const tmpDir = `${distDir}/tmp`;
const publicDir = `${tmpDir}/public`;
const outDir = `${distDir}/${platform}`;

async function zipDirectoryToFile(sourceDir, targetFile) {
    const zipFile = new yazl.ZipFile();
    const entries = await fs.readdir(sourceDir, {withFileTypes: true});

    async function addDir(baseDir, relativeDir = '') {
        const dirPath = (relativeDir ? path.join(baseDir, relativeDir) : baseDir);
        const dirEntries = await fs.readdir(dirPath, {withFileTypes: true});

        for (const entry of dirEntries) {
            const entryRelativePath = (relativeDir ? path.join(relativeDir, entry.name) : entry.name);
            const entryFullPath = path.join(baseDir, entryRelativePath);

            if (entry.isDirectory()) {
                await addDir(baseDir, entryRelativePath);
            } else if (entry.isFile()) {
                zipFile.addFile(entryFullPath, entryRelativePath.replace(/\\/g, '/'));
            }
        }
    }

    if (entries.length)
        await addDir(sourceDir);

    await fs.ensureDir(path.dirname(targetFile));
    await new Promise((resolve, reject) => {
        zipFile.outputStream
            .pipe(fs.createWriteStream(targetFile))
            .on('close', resolve)
            .on('error', reject);
        zipFile.end();
    });
}

async function bundleJxlDecoder() {
    const binDir = path.join(outDir, 'bin');
    await fs.ensureDir(binDir);
    const targets = {
        win: 'win32-x64-msvc',
        linux: 'linux-x64-gnu',
        'linux-arm64': 'linux-arm64-gnu',
        macos: 'darwin-x64',
    };
    const target = targets[platform];
    if (!target) return;

    let binding;
    try {
        binding = require.resolve(`@napi-rs/image-${target}`);
    } catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        console.warn(`Optional JXL addon for ${target} is unavailable, using djxl`);
        return;
    }
    await fs.copy(binding, path.join(binDir, 'inpx-jxl.node'));
    await fs.copy(path.join(path.dirname(require.resolve('@napi-rs/image')), 'LICENSE'),
        path.join(binDir, 'LICENSE.inpx-jxl'));
}

async function build() {
    if (!platform || args.filter(value => value !== '--rust').length !== 1)
        throw new Error('Usage: node build/prepkg.js <target> [--rust]');
    const [application] = executableNames(platform, false);

    const rustTarget = process.env.CARGO_TARGET_DIR || path.resolve(__dirname,'../rust/target');
    const authState = process.env.INPX_RUST_AUTH_WASM || path.join(rustTarget,'wasm32-unknown-unknown/release',authStateFile);
    const authBytes = native ? null : await fs.readFile(authState);
    if (authBytes && !WebAssembly.validate(authBytes))
        throw new Error(`Invalid Rust authentication module: ${authState}`);
    const nativePlatform = {win:'win32:x64',linux:'linux:x64','linux-arm64':'linux:arm64',macos:'darwin:x64'};
    const programs = [];
    for (const program of ['server','catalog','reader']) {
        const entry = rustProgramEntry(platform,program);
        let source = process.env[`INPX_RUST_${program.toUpperCase()}_BINARY`];
        if (!source && nativePlatform[platform] === `${process.platform}:${process.arch}`) {
            const local = path.join(rustTarget,'release',path.basename(entry));
            if (await fs.pathExists(local)) source = local;
        }
        if (source) {
            await fs.access(source);
            programs.push({source,entry:native && program === 'server' ? application : entry});
        } else if (native) {
            throw new Error(`Missing Rust ${program} for ${platform}. Build it or set INPX_RUST_${program.toUpperCase()}_BINARY.`);
        }
    }

    if (!native) require('./patch-pkg')();
    await fs.access(path.join(publicDir,'index.html'));

    await fs.emptyDir(outDir);
    await fs.ensureDir(path.join(outDir,'bin'));
    if (authBytes) {
        await bundleJxlDecoder();
        await fs.writeFile(path.join(outDir,'bin',authStateFile),authBytes);
    }
    for (const {source,entry} of programs) {
        const output = path.join(outDir,entry);
        await fs.copyFile(source,output);
        if (platform!=='win') await fs.chmod(output,0o755);
    }

    // Добавляем README в релиз.
    let readme = await fs.readFile(path.resolve(__dirname, '../README.md'), 'utf-8');
    const converter = new MarkdownIt({html: true, linkify: true});
    readme = converter.render(readme);
    await fs.writeFile(`${outDir}/readme.html`, readme);

    const zipFile = `${tmpDir}/public.zip`;
    const jsonFile = native ? path.join(outDir,'bin','public.json') : path.join(distDir,'public.json');
    await fs.remove(zipFile);
    await zipDirectoryToFile(publicDir, zipFile);
    const data = (await fs.readFile(zipFile)).toString('base64');
    await fs.writeFile(jsonFile, JSON.stringify({data}));
}

async function main() {
    try {
        await build();
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}

main();
