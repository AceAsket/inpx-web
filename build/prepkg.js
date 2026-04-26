const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');

const showdown = require('showdown');

const platform = process.argv[2];

const distDir = path.resolve(__dirname, '../dist');
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

async function build() {
    if (!platform)
        throw new Error(`Please set platform`);

    await fs.emptyDir(outDir);

    // Добавляем README в релиз.
    let readme = await fs.readFile(path.resolve(__dirname, '../README.md'), 'utf-8');
    const converter = new showdown.Converter();
    readme = converter.makeHtml(readme);
    await fs.writeFile(`${outDir}/readme.html`, readme);

    // Упаковываем public в public.json для pkg.
    if (await fs.pathExists(publicDir)) {

        const zipFile = `${tmpDir}/public.zip`;
        const jsonFile = `${distDir}/public.json`;//distDir !!!

        await fs.remove(zipFile);
        await zipDirectoryToFile(publicDir, zipFile);

        const data = (await fs.readFile(zipFile)).toString('base64');
        await fs.writeFile(jsonFile, JSON.stringify({data}));
    } else {
        throw new Error(`publicDir: ${publicDir} does not exist`);
    }
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
