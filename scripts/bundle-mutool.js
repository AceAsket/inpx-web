const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const version = '1.28.6';
const sourceUrl = `https://casper.mupdf.com/downloads/archive/mupdf-${version}-source.tar.gz`;
const sha256 = 'dc85000640a45d90ca9b77b061f6ca67cce0c4d4fbecf8819647baf573eef101';

const nativeTarget = {'linux:x64':'linux', 'linux:arm64':'linux-arm64', 'darwin:x64':'macos', 'win32:x64':'win'}[`${process.platform}:${process.arch}`];

async function bundleMutool(target, bin, sourceArchive) {
    if (!target || target !== nativeTarget)
        throw new Error('Build mutool on the native release target: linux, linux-arm64, macos or win');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-mutool-'));
    try {
        const archive = path.join(temp, 'source.tar.gz');
        if (sourceArchive) await fs.copyFile(sourceArchive, archive);
        else execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3',
            '--connect-timeout', '20', '--max-time', '600', '--output', archive, sourceUrl], {stdio:'inherit'});
        if (createHash('sha256').update(await fs.readFile(archive)).digest('hex') !== sha256)
            throw new Error('MuPDF source checksum mismatch');
        execFileSync('tar', ['-xzf', 'source.tar.gz'], {cwd:temp, stdio:'inherit'});
        const cwd = path.join(temp, `mupdf-${version}-source`);
        const jobs = Math.min(os.availableParallelism(), 8);
        const windows = target === 'win';
        const file = windows ? 'mutool.exe' : 'mutool';
        let built;
        if (windows) {
            execFileSync('msbuild', ['platform/win32/mupdf.sln', '/t:mutool', `/m:${jobs}`,
                '/p:Configuration=Release;Platform=x64;PlatformToolset=v143'], {
                cwd, stdio:'inherit', env:{...process.env, _CL_:'/MT'},
            });
            built = path.join(cwd, 'platform/win32/x64/Release', file);
        } else {
            built = path.join(cwd, 'build/release', file);
            execFileSync('make', [`-j${jobs}`, 'HAVE_X11=no', 'HAVE_GLUT=no', 'HAVE_CURL=no', 'HAVE_LIBCRYPTO=no',
                ...(target.startsWith('linux') ? ['LDFLAGS=-static'] : []), 'build/release/mutool'], {cwd, stdio:'inherit'});
            execFileSync('strip', [built]);
        }
        execFileSync(built, ['-v'], {stdio:'inherit'});
        await fs.mkdir(bin, {recursive:true});
        await fs.copyFile(built, path.join(bin, file));
        if (!windows) await fs.chmod(path.join(bin, file), 0o755);
        await fs.copyFile(path.join(cwd, 'COPYING'), path.join(bin, 'LICENSE.mupdf'));
        await fs.copyFile(path.join(cwd, 'docs/other/third-party.rst'), path.join(bin, 'mupdf-third-party.rst'));
        const notices = ['{thirdparty,resources/fonts}/*/{COPYING,LICENSE,LICENSE.txt,LICENSE.TXT,NOTICE,OFL.txt}',
            'thirdparty/freetype/docs/FTL.TXT', 'thirdparty/libjpeg/README'];
        for await (const name of fs.glob(notices, {cwd})) {
            const dest = path.join(bin, 'mupdf-licenses', name);
            await fs.mkdir(path.dirname(dest), {recursive:true});
            await fs.copyFile(path.join(cwd, name), dest);
        }
        await fs.writeFile(path.join(bin, 'mupdf-source.txt'), `MuPDF ${version}\n${sourceUrl}\nSHA256 ${sha256}\n`);
    } finally {
        await fs.rm(temp, {recursive:true, force:true});
    }
}

module.exports = {bundleMutool, nativeTarget};
if (require.main === module) {
    const [target, archive] = process.argv.slice(2);
    bundleMutool(target, path.resolve('dist', target || '', 'bin'), archive)
        .catch(error => { console.error(error); process.exitCode = 1; });
}
