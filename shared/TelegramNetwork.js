function normalizeIpFamily(value = 'auto') {
    if (value != null && !['string', 'number'].includes(typeof value))
        throw new Error('Семейство IP для Telegram: auto, 4 или 6');
    const family = String(value ?? 'auto').trim().toLowerCase();
    if (family === '' || family === 'auto' || family === '0') return 'auto';
    if (family === '4' || family === '6') return family;
    throw new Error('Семейство IP для Telegram: auto, 4 или 6');
}

function requestOptions(config = {}) {
    const family = normalizeIpFamily(config.telegramIpFamily);
    // Axios forwards family to Node's connection options. Keep the default
    // dual-stack behavior unless the administrator explicitly selects a family.
    return family === 'auto' ? {} : {family: Number(family)};
}

module.exports = {normalizeIpFamily, requestOptions};
