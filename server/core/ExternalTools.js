const fs = require('fs-extra');
const path = require('path');

const SEVEN_ZIP_DOWNLOAD_URL = 'https://www.7-zip.org/download.html';
const DJXL_DOWNLOAD_URL = 'https://github.com/libjxl/libjxl/releases/latest';
const DWEBP_DOWNLOAD_URL = 'https://developers.google.com/speed/webp/docs/precompiled';

function bundledBinDir() {
    if (!process.pkg)
        return '';

    return path.join(path.dirname(process.execPath), 'bin');
}

function resolveBundledPath(fileName) {
    const binDir = bundledBinDir();
    if (!binDir)
        return '';

    return path.join(binDir, fileName);
}

function sevenZipCommandCandidates() {
    const local = [
        resolveBundledPath('7z.exe'),
        resolveBundledPath('7za.exe'),
        resolveBundledPath('7zr.exe'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        '7z',
        '7za',
        '7zr',
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    ] : [
        '7z',
        '7za',
        '7zr',
    ]);

    return [...local, ...system];
}

function toolCandidatesFromDirs(extraDirs = [], fileNames = []) {
    const result = [];
    for (const dir of (Array.isArray(extraDirs) ? extraDirs : [])) {
        const baseDir = String(dir || '').trim();
        if (!baseDir)
            continue;

        for (const fileName of fileNames)
            result.push(path.join(baseDir, fileName));
    }

    return result;
}

function djxlCommandCandidates(extraDirs = []) {
    const extra = toolCandidatesFromDirs(extraDirs, process.platform === 'win32' ? ['djxl.exe', 'djxl'] : ['djxl']);
    const local = [
        process.platform === 'win32' ? resolveBundledPath('djxl.exe') : '',
        resolveBundledPath('djxl'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        'djxl',
        'djxl.exe',
    ] : [
        'djxl',
    ]);

    return [...extra, ...local, ...system];
}

function dwebpCommandCandidates(extraDirs = []) {
    const extra = toolCandidatesFromDirs(extraDirs, process.platform === 'win32' ? ['dwebp.exe', 'dwebp'] : ['dwebp']);
    const local = [
        process.platform === 'win32' ? resolveBundledPath('dwebp.exe') : '',
        resolveBundledPath('dwebp'),
    ].filter(Boolean);

    const system = (process.platform === 'win32' ? [
        'dwebp',
        'dwebp.exe',
    ] : [
        'dwebp',
    ]);

    return [...extra, ...local, ...system];
}

function missingSevenZipMessage() {
    if (process.platform === 'win32') {
        return `Не найден 7-Zip CLI для чтения 7z-архивов с обложками. Установите 7-Zip или положите 7zr.exe/7z.exe в каталог bin рядом с inpx-web.exe. Ссылка: ${SEVEN_ZIP_DOWNLOAD_URL}`;
    }

    return `Не найден 7-Zip CLI для чтения 7z-архивов с обложками. Установите 7z/7za/7zr через пакетный менеджер вашей системы. Ссылка: ${SEVEN_ZIP_DOWNLOAD_URL}`;
}

function missingDjxlMessage() {
    if (process.platform === 'win32') {
        return `Не найден djxl для декодирования JXL-обложек. Установите libjxl или положите djxl.exe и его DLL в каталог bin рядом с inpx-web.exe. Ссылка: ${DJXL_DOWNLOAD_URL}`;
    }

    return `Не найден djxl для декодирования JXL-обложек. Установите libjxl-tools или аналогичный пакет вашей системы. Ссылка: ${DJXL_DOWNLOAD_URL}`;
}

function missingDwebpMessage() {
    if (process.platform === 'win32') {
        return `Не найден dwebp для декодирования WebP-обложек. Установите libwebp или положите dwebp.exe и его DLL в каталог bin рядом с inpx-web.exe. Ссылка: ${DWEBP_DOWNLOAD_URL}`;
    }

    return `Не найден dwebp для декодирования WebP-обложек. Установите webp/libwebp-tools или аналогичный пакет вашей системы. Ссылка: ${DWEBP_DOWNLOAD_URL}`;
}

function createMissingToolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function isMissingToolError(error, code = '') {
    if (!error)
        return false;

    return code ? error.code === code : /^INPX_MISSING_/.test(String(error.code || ''));
}

async function pathExistsSafe(filePath) {
    try {
        return Boolean(filePath) && await fs.pathExists(filePath);
    } catch (err) {
        return false;
    }
}

module.exports = {
    SEVEN_ZIP_DOWNLOAD_URL,
    DJXL_DOWNLOAD_URL,
    DWEBP_DOWNLOAD_URL,
    bundledBinDir,
    sevenZipCommandCandidates,
    djxlCommandCandidates,
    dwebpCommandCandidates,
    missingSevenZipMessage,
    missingDjxlMessage,
    missingDwebpMessage,
    createMissingToolError,
    isMissingToolError,
    pathExistsSafe,
};
