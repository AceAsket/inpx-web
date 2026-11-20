const preferred = ['ru', 'en'];
const compoundScripts = {
    Hans:['Han'], Hant:['Han'], Jpan:['Han','Hiragana','Katakana'], Kore:['Hangul','Han'],
    Hanb:['Han','Bopomofo'], Hrkt:['Hiragana','Katakana'],
};

function languageOptions(codes, includeAll = false) {
    const options = [...new Set(codes)].map(value => ({value, label:value.toUpperCase()}));
    if (includeAll) options.push({value:'', label:'Все языки'});
    const rank = code => {
        const index = preferred.indexOf(code.toLowerCase());
        return index >= 0 ? index : code ? 3 : 2;
    };
    return options.sort((a,b) => rank(a.value) - rank(b.value) || a.label.localeCompare(b.label, 'en'));
}

function alphabetFor(language) {
    try {
        const locale = new Intl.Locale(language.replace(/_/g, '-')).maximize();
        if (locale.language === 'ru' && locale.script === 'Cyrl') return /^[а-яё]/iu;
        if (locale.language === 'en' && locale.script === 'Latn') return /^[a-z]/i;
        const scripts = compoundScripts[locale.script] || [locale.script];
        return new RegExp('^(?:' + scripts.map(script => '\\p{Script_Extensions=' + script + '}').join('|') + ')', 'u');
    } catch { return null; }
}

function sortIndexRows(rows, field, prefix, language) {
    const codes = language ? language.split(',').map(code => code.trim()).filter(Boolean) : preferred;
    const alphabets = codes.map(alphabetFor).filter(Boolean);
    let collator;
    try { collator = new Intl.Collator(codes, {numeric:true}); }
    catch { collator = new Intl.Collator('ru', {numeric:true}); }
    function rank(suffix) {
        if (!suffix) return -1;
        const script = alphabets.findIndex(alphabet => alphabet.test(suffix));
        if (script >= 0) return script;
        if (/^\p{L}/u.test(suffix)) return alphabets.length;
        return alphabets.length + (/^\p{N}/u.test(suffix) ? 1 : 2);
    }
    return rows.map(row => {
        const suffix = row[field].slice(prefix.length).trimStart().normalize('NFC');
        return {row, suffix, rank:rank(suffix)};
    }).sort((a,b) => a.rank - b.rank || collator.compare(a.suffix,b.suffix)).map(entry => entry.row);
}

module.exports = {languageOptions, sortIndexRows};
