const formats = ['epub', 'epub3', 'kepub', 'kfx', 'azw8', 'pdf', 'mobi'];
const defaults = formats.filter(format => format !== 'mobi');
const preferenceFields = {download:'defaultDownloadFormat', email:'defaultEmailFormat', telegram:'defaultTelegramFormat', opds:'defaultOpdsFormat'};

function normalize(value) {
    const format = String(value || '').trim().toLowerCase();
    return formats.includes(format) ? format : 'original';
}

function configured(config = {}) {
    if (config.conversionEnabled === false) return [];
    const source = Array.isArray(config.conversionFormats) ? config.conversionFormats : [...defaults, ...(config.mobiEnabled === true ? ['mobi'] : [])];
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

function preference(profile = {}, channel = 'download') {
    const value = profile[preferenceFields[channel] || preferenceFields.download];
    // RC8 used one preference for web downloads and both delivery channels.
    return normalize(value === undefined && ['email', 'telegram'].includes(channel) ? profile.defaultDownloadFormat : value);
}

function profilePreference(config = {}, channel = 'download') {
    return config.profileAuthorized ? preference(config.currentUserProfile || {}, channel) : 'original';
}

module.exports = {formats, normalize, configured, available, resolve, preference, preferenceFields, profilePreference};
