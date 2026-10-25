const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const {execFileSync} = require('child_process');

const version = 'v0.45.6';
const assets = {
    win: ['kindling-cli-windows.exe', '1988a319d0d9af2e75cf776eb9e63a59412fcd8ebfc5d0cebb000519ccd99f54'],
    macos: ['kindling-cli-mac-intel', 'e4ebea49f37907c35ae3d7678a61840333bb01779705424219c731c230a844dc'],
};

async function download(url, digest, destination) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
            if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
            const data = Buffer.from(await response.arrayBuffer());
            if (crypto.createHash('sha256').update(data).digest('hex') !== digest) throw new Error(`SHA256 mismatch: ${url}`);
            await fs.writeFile(destination, data);
            return;
        } catch (error) { lastError = error; }
    }
    throw lastError;
}

async function main() {
    const target = process.argv[2];
    if (!['win', 'macos', 'linux', 'linux-arm64'].includes(target)) throw new Error('Usage: node scripts/bundle-kindling.js win|macos|linux|linux-arm64');
    const bin = path.resolve(__dirname, `../dist/${target}/bin`);
    await fs.ensureDir(bin);
    if (target.startsWith('linux')) {
        execFileSync('docker', ['buildx', 'build', '--platform', target === 'linux' ? 'linux/amd64' : 'linux/arm64',
            '--target', 'kindling-tools', '--output', `type=local,dest=${bin}`, '-f', 'Dockerfile', '.'],
        {cwd: path.resolve(__dirname, '..'), stdio: 'inherit'});
    } else {
        const [name, digest] = assets[target];
        await download(`https://github.com/ciscoriordan/kindling/releases/download/${version}/${name}`, digest,
            path.join(bin, target === 'win' ? 'kindling.exe' : 'kindling'));
        await download(`https://raw.githubusercontent.com/ciscoriordan/kindling/${version}/LICENSE`,
            '54e876c71607752a62dfd9a11e32280abb650463993f756e937690911d6c4b2b', path.join(bin, 'LICENSE.kindling'));
    }
    if (target !== 'win') await fs.chmod(path.join(bin, 'kindling'), 0o755);
    console.log(`Bundled Kindling ${version} for ${target}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
