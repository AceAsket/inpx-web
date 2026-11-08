const sensitive = /password|passwd|token|secret|authorization|contentbase64|^telegramproxyusername$|^data$|^key$|^salt$/i;
function redact(value, depth = 0) {
    if (depth > 5) return '[…]';
    if (typeof value === 'string') return value.replace(/https:\/\/t\.me\/[A-Za-z0-9_]+\?start=link_[A-Za-z0-9_-]+/g, '[private Telegram link]')
        .replace(/\b((?:https?|socks5h?):\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,'$1[redacted]@')
        .replace(/(https:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/\s]+/gi,'$1[redacted]')
        .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi,'Basic [redacted]')
        .replace(/([?&](?:token|password|secret|key)=)[^&\s]*/gi,'$1[redacted]').slice(0, 300);
    if (Array.isArray(value)) return value.slice(0, 10).map(item => redact(item, depth + 1));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : redact(item, depth + 1)]));
}
module.exports = {redact};
