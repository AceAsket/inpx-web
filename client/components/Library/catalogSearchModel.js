const textFields = ['title', 'author', 'series'];
const textFieldLabels = {title:'Название книги', author:'Автор', series:'Серия'};
function primaryTextField(section) {
    return section === 'author' || section === 'series' ? section : 'title';
}

function sectionSearchValues(values, fromSection, toSection) {
    const result = Object.fromEntries(textFields.map(field => [field, String(values[field] || '')]));
    const sections = ['books','title','author','series'];
    const from = primaryTextField(fromSection), to = primaryTextField(toSection);
    // A single query follows the selected search field. Explicit combinations
    // keep their meaning and remain visible as additional conditions.
    if (sections.includes(fromSection) && sections.includes(toSection) && from !== to
        && result[from] && textFields.filter(field => result[field]).length === 1) {
        result[to] = result[from]; result[from] = '';
    }
    return result;
}
const filterFields = ['genre', 'lang', 'ext', 'date', 'librate', 'ratingCount', 'isbn', 'keywords', 'sourceId', 'hideCopies'];
const filterLabels = {genre: 'Жанр', lang: 'Язык', ext: 'Формат', date: 'Дата добавления', librate: 'Оценка',
    ratingCount: 'Число голосов', isbn: 'ISBN', keywords: 'Ключевые слова', sourceId: 'Библиотека', hideCopies: 'Без копий'};

function decodeText(value = '') {
    value = String(value || '');
    if (value.startsWith('*')) return {text: value.slice(1), mode: 'contains'};
    if (value.startsWith('=')) return {text: value.slice(1), mode: 'exact'};
    return {text: value, mode: value ? 'starts' : 'contains'};
}

function encodeText(text = '', mode = 'contains') {
    text = String(text || '');
    if (!text.trim()) return '';
    // Keep advanced catalog expressions compatible with existing links and help.
    if (/^[~?#]/.test(text)) return text;
    return `${mode === 'exact' ? '=' : mode === 'contains' ? '*' : ''}${text}`;
}

function canAutoSearch(draft) {
    return textFields.every(field => {
        const value = String(draft[field]?.text || '').trim();
        return !value || Array.from(value).length >= 2;
    });
}

function filtersFrom(query = {}) {
    return Object.fromEntries(filterFields.map(field => [field, field === 'hideCopies' ? !!query[field] : String(query[field] || '')]));
}

function activeFilters(query = {}, genreMap = new Map(), sources = []) {
    return filterFields.filter(field => !!query[field]).map(field => {
        const value = String(query[field]);
        let label = value;
        if (field === 'genre') label = value.split(',').map(code => genreMap.get(code) || code).join(', ');
        if (field === 'sourceId') label = sources.find(source => source.id === value)?.name || value;
        if (field === 'librate') label = value.split(',').map(rate => `${rate}/5`).join(', ');
        if (field === 'ext') label = value.toUpperCase();
        if (field === 'date') label = value.split(',').map(date => date || '…').join(' — ');
        return {field, label: field === 'hideCopies' ? filterLabels[field] : `${filterLabels[field]}: ${label}`};
    });
}

// Preserve the common scope without reusing another entity's name or page.
function catalogScope(query = {}) {
    return Object.fromEntries(['lang', 'ext', 'genre', 'sourceId'].map(field => [field, String(query[field] || '').trim()]).filter(([, value]) => value));
}

function catalogTarget(path, parameters = {}, scope = {}) {
    return {path, query:{...catalogScope(scope), ...parameters}};
}

// Match the catalog's first-visit server defaults and later browser settings.
function effectiveCatalogScope(query = {}, settings = {}, config = {}) {
    const defaultLang = !settings.defaultsSet && typeof config.uiDefaults?.langDefault === 'string'
        ? config.uiDefaults.langDefault : settings.langDefault;
    return catalogScope({...query, lang:typeof query.lang === 'string' ? query.lang : defaultLang});
}

module.exports = {textFields, textFieldLabels, primaryTextField, sectionSearchValues, filterFields, filterLabels, decodeText, encodeText, canAutoSearch, filtersFrom, activeFilters, catalogScope, catalogTarget, effectiveCatalogScope};
