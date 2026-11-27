const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const pckg = require('../package.json');

const rootDir = path.resolve(__dirname, '..');
const distDir = require('./dist-dir');
const sourceDir = path.join(distDir, 'win');
const outputDir = path.join(distDir, 'release');
const scriptFile = path.join(__dirname, 'windows-installer.iss');
const rust = process.argv.includes('--rust') || fs.existsSync(path.join(sourceDir, 'bin', 'public.json'));

function quoteDefine(value) {
    return String(value).replace(/"/g, '\\"');
}

function makeVersionInfoVersion(version) {
    const parts = String(version)
        .match(/\d+/g)
        ?.slice(0, 4)
        .map(part => Math.min(parseInt(part, 10) || 0, 65535)) || [];

    while (parts.length < 4)
        parts.push(0);

    return parts.join('.');
}

function findCompiler() {
    const envCompiler = process.env.INNO_SETUP_COMPILER;
    if (envCompiler && fs.existsSync(envCompiler))
        return envCompiler;

    const candidates = [
        'ISCC.exe',
        'iscc.exe',
        path.join(process.env['ProgramFiles(x86)'] || '', 'Inno Setup 6', 'ISCC.exe'),
        path.join(process.env.ProgramFiles || '', 'Inno Setup 6', 'ISCC.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const result = spawnSync(candidate, ['/Q'], {stdio: 'ignore'});
        if (!result.error || result.error.code !== 'ENOENT')
            return candidate;
    }

    return '';
}

function ensureInputFiles() {
    const exeFile = path.join(sourceDir, 'inpx-web.exe');
    if (!fs.existsSync(exeFile))
        throw new Error(`Windows build output is missing: ${exeFile}. Run "npm run build:win" or "npm run build:rust -- win" first.`);
    if (rust) {
        for (const file of ['vcruntime140.dll', 'bin/vcruntime140.dll', 'bin/public.json', 'bin/LICENSE.quickjs', 'bin/7za.exe',
            'bin/djxl.exe', 'bin/dwebp.exe', 'bin/fbc.exe', 'bin/kindling.exe', 'bin/LICENSE.kindling',
            'bin/mutool.exe', 'bin/LICENSE.mupdf'])
            fs.accessSync(path.join(sourceDir, file));
    }
}

function main() {
    ensureInputFiles();
    fs.mkdirSync(outputDir, {recursive: true});

    const compiler = findCompiler();
    if (!compiler) {
        throw new Error(
            'Inno Setup compiler was not found. Install Inno Setup 6 and add ISCC.exe to PATH, ' +
            'or set INNO_SETUP_COMPILER to the full ISCC.exe path.'
        );
    }

    const args = [
        `/DAppVersion=${quoteDefine(pckg.version)}`,
        `/DAppVersionInfo=${makeVersionInfoVersion(pckg.version)}`,
        `/DRepoRoot=${quoteDefine(rootDir)}`,
        `/DSourceDir=${quoteDefine(sourceDir)}`,
        `/DOutputDir=${quoteDefine(outputDir)}`,
        ...(rust ? ['/DRustRuntime=1'] : []),
        scriptFile,
    ];

    const result = spawnSync(compiler, args, {stdio: 'inherit', windowsVerbatimArguments: false});
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        process.exit(result.status || 1);

    const installerFile = path.join(outputDir, `inpx-web-${pckg.version}-win${rust ? '-rust' : ''}-setup.exe`);
    console.log(`Windows installer: ${installerFile}`);
}

try {
    main();
} catch (err) {
    console.error(err.message || err);
    process.exit(1);
}
