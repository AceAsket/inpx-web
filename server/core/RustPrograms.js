const {existsSync} = require('node:fs');
const {dirname,join,resolve} = require('node:path');
const bundled = new Map();

function fileName(program, windows = process.platform === 'win32') {
    return `inpx-${program}${windows ? '.exe' : ''}`;
}

function executable(program) {
    const configured = process.env[`INPX_RUST_${program.toUpperCase()}_BINARY`];
    if (configured) return resolve(configured);
    if (!process.pkg) return null;
    if (!bundled.has(program)) {
        const path = join(dirname(process.execPath),'bin',fileName(program));
        bundled.set(program,existsSync(path) ? path : null);
    }
    return bundled.get(program);
}

module.exports = {fileName,executable};
