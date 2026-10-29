const formats = ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf', 'mobi'];
const defaults = formats.filter(format => format !== 'mobi');

function normalize(value) {
    const format = String(value || '').trim().toLowerCase();
    return formats.includes(format) ? format : 'original';
}

function configured(config = {}) {
    if (config.conversionEnabled === false) return [];
    const source = Array.isArray(config.conversionFormats) ? config.conversionFormats : defaults;
    return [...new Set(source.map(value => String(value).toLowerCase()))]
        .filter(format => formats.includes(format) && (format !== 'mobi' || config.mobiEnabled !== false));
}

function available(ext, config = {}) {
    const source = String(ext || '').toLowerCase();
    return configured(config).filter(format => source === 'fb2' || source === 'epub' && ['pdf', 'mobi'].includes(format));
}

function resolve(ext, config = {}, preference = 'original', explicit = '') {
    const selected = String(explicit || '').trim().toLowerCase();
    if (selected === 'original' || selected === 'raw' || selected && selected === String(ext || '').toLowerCase()) return 'raw';
    // Explicit actions keep their existing server-side validation and errors.
    if (selected) return selected;
    const preferred = normalize(preference);
    return available(ext, config).includes(preferred) ? preferred : '';
}

function profilePreference(config = {}) {
    return config.profileAuthorized ? normalize(config.currentUserProfile?.defaultDownloadFormat) : 'original';
}

module.exports = {formats, normalize, configured, available, resolve, profilePreference};
