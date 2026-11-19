const fs = require('fs-extra');
const path = require('path');
const {createReleaseArchive} = require('./release-archive');

const {bundleLinuxDjxl} = require('./linux-djxl');
const {bundleMutool, nativeTarget} = require('../scripts/bundle-mutool');

const pckg = require('../package.json');
const args = process.argv.slice(2);
const platform = args.find(arg => arg !== '--application-only');
const applicationOnly = args.includes('--application-only');

const distDir = path.resolve(__dirname, '../dist');
const outDir = `${distDir}/release`;

async function makeRelease(target) {
    const srcDir = `${distDir}/${target}`;

    if (await fs.pathExists(srcDir)) {
        const zipFile = `${outDir}/${pckg.name}-${pckg.version}-${target}.zip`;

        const bin = `${srcDir}/bin`;
        if (!applicationOnly) {
            if (target === nativeTarget) await bundleMutool(target, bin);
            else if (!await fs.pathExists(`${bin}/mutool${target === 'win' ? '.exe' : ''}`))
                throw new Error(`Stage the ${target} MuPDF files in ${bin} before cross-packaging, or pass --application-only.`);
        }
        if (target === 'linux' || target === 'linux-arm64')
            await bundleLinuxDjxl(target, `${srcDir}/bin`);
        await createReleaseArchive(srcDir, zipFile, target);
        console.log(`Release archive: ${zipFile}`);
    }
}

async function main() {
    try {
        await fs.emptyDir(outDir);
        if (platform) {
            await makeRelease(platform);
        } else {
            await makeRelease('win');
            await makeRelease('linux');
            await makeRelease('linux-arm64');
            await makeRelease('macos');
        }
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}

main();
