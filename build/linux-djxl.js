const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const version = 'v0.13.0';
const assets = {
    linux: ['x86_64', '637599dae477dbb4e6d6ee71b0554e8a65c20dc25fd2892cf2bebb935d54d527'],
    'linux-arm64': ['aarch64', '387ccda06301ebda7128c33dc2cce39962cf978eca5ddb6fb288775fc53ee2fc'],
};

async function bundleLinuxDjxl(target, binDir) {
    const [arch, sha256] = assets[target];
    const name = `jxl-linux-${arch}-static.tar.lz`;
    const url = `https://github.com/libjxl/libjxl/releases/download/${version}/${name}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error(`Download failed for ${name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
        throw new Error(`SHA256 mismatch for ${name}`);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-djxl-'));
    try {
        const archive = path.join(tmp, name);
        await fs.writeFile(archive, bytes);
        execFileSync('tar', ['-xf', name], {cwd: tmp});
        const licenses = path.join(binDir, 'djxl-licenses');
        await fs.mkdir(licenses, {recursive: true});
        for (const entry of await fs.readdir(tmp)) {
            if (entry.startsWith('LICENSE.')) await fs.copyFile(path.join(tmp, entry), path.join(licenses, entry));
        }
        const executable = path.join(binDir, 'djxl');
        await fs.copyFile(path.join(tmp, 'tools', 'djxl'), executable);
        await fs.chmod(executable, 0o755);
    } finally {
        await fs.rm(tmp, {recursive: true, force: true});
    }
}

module.exports = {bundleLinuxDjxl};
