const defaultSpeechOptions = () => ({pitch: 'medium', sentencePauseMs: null, paragraphPauseMs: null, chapterPauseMs: null, dictionary: ''});

function normalizeSpeechOptions(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные настройки озвучки.');
    const result = defaultSpeechOptions();
    if (value.pitch !== undefined) {
        if (!['x-low', 'low', 'medium', 'high', 'x-high'].includes(value.pitch)) throw new Error('Неизвестная высота голоса.');
        result.pitch = value.pitch;
    }
    for (const [key, max] of [['sentencePauseMs', 2000], ['paragraphPauseMs', 5000], ['chapterPauseMs', 10000]]) {
        if (value[key] === undefined || value[key] === null) continue;
        if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max) throw new Error('Недопустимая длительность паузы.');
        result[key] = value[key];
    }
    if (value.dictionary !== undefined && typeof value.dictionary !== 'string') throw new Error('Словарь должен быть текстом.');
    if ((value.dictionary || '').length > 10000) throw new Error('Словарь слишком большой (до 10 000 символов).');
    const rules = [], seen = new Set();
    for (const line of (value.dictionary || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        const separator = line.indexOf('=');
        const word = line.slice(0, separator).trim(), pronunciation = line.slice(separator + 1).trim();
        if (separator < 1 || !word || !pronunciation || word.length > 100 || pronunciation.length > 200
            || !/^[\p{L}\p{N} '\u2019.-]+$/u.test(word) || !/^[\p{L}\p{N}+ '\u2019.,!?-]+$/u.test(pronunciation)
            || !/[а-яё]/i.test(pronunciation) || /\+(?![аеёиоуыэюя])/i.test(pronunciation))
            throw new Error('Словарь: одна строка «слово = произношение», + перед ударной гласной.');
        const key = word.toLowerCase();
        if (seen.has(key)) throw new Error(`В словаре повторяется «${word}».`);
        seen.add(key); rules.push(`${word} = ${pronunciation}`);
    }
    if (rules.length > 100) throw new Error('В словаре допускается до 100 замен.');
    result.dictionary = rules.join('\n');
    return result;
}

function hasSpeechOptions(options) {
    return JSON.stringify(options) !== JSON.stringify(defaultSpeechOptions());
}

module.exports = {defaultSpeechOptions, normalizeSpeechOptions, hasSpeechOptions};
