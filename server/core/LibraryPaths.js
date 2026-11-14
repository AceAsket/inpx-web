const fs = require('fs-extra');
const path = require('path');

function invalidPath() {
    return Object.assign(new Error('Путь выходит за пределы источника библиотеки'), {code:'INPX_LIBRARY_PATH'});
}

function relativeName(value) {
    const name = String(value || '').replace(/\\/g, '/');
    const parts = name.split('/');
    if (name.startsWith('/') || /[:\x00-\x1f]/.test(name) || parts.includes('..')
        || process.platform === 'win32' && parts.some(part => part !== '.' && /[. ]$/.test(part)))
        throw invalidPath();
    return name;
}

function relativeToRoot(root, target) {
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw invalidPath();
    return relative;
}

async function realPathWithin(root, target) {
    const real = await fs.realpath(target);
    relativeToRoot(root, real);
    return real;
}

module.exports = {relativeName, relativeToRoot, realPathWithin};
