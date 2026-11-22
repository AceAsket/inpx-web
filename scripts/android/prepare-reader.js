const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const lock = require('../../android/reader.lock.json');
const revision = lock.revision;
const checkout = process.argv[2];
if (!checkout) throw new Error('Usage: node scripts/android/prepare-reader.js <local inpx-reader-android checkout>');

const root = path.resolve(__dirname, '../..');
const build = path.join(root, 'android', 'build');
fs.mkdirSync(build, {recursive:true});
const output = fs.mkdtempSync(path.join(build, 'reader-source-'));
const archive = path.join(output, 'reader.tar');
try {
    execFileSync('git', ['-C', path.resolve(checkout), 'archive', '--format=tar', `--output=${archive}`,
        revision, 'app/src/main'], {stdio:'inherit'});
    execFileSync('tar', ['-xf', archive, '-C', output], {stdio:'inherit'});
    execFileSync('git', ['apply', '--no-index', '--ignore-space-change', path.join(root, 'android/reader/embedded.patch')],
        {cwd:output, stdio:'inherit', env:{...process.env, GIT_CEILING_DIRECTORIES:build}});
    console.log(output);
} finally {if (fs.existsSync(archive)) fs.unlinkSync(archive);}
