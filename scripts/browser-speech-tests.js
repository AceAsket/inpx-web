const assert = require('assert/strict');
const {BrowserSpeech, phrases, supported} = require('../client/components/Reader/browserSpeech');

function player(parts = [{text: 'Первая фраза.'}, {text: 'Вторая фраза.'}]) {
    const calls = [], states = [];
    const synth = {cancel() {}, getVoices: () => [{voiceURI: 'local', lang: 'en-US'}], speak: utterance => calls.push(utterance)};
    const speech = new BrowserSpeech({synth, Utterance: class {constructor(text) {this.text = text;}}, onChange: state => states.push(state)});
    speech.setParts(parts);
    return {speech, calls, states};
}

async function testBrowserSpeechBoundedPhrases() {
    const source = 'Это первая фраза. Вторая фраза! ' + 'Очень длинное предложение без точки '.repeat(100) + '𐐀'.repeat(300);
    const chunks = phrases(source);
    assert(chunks.every(part => part.length <= 220));
    assert.equal(chunks.map(part => part.replace(/\s/g, '')).join(''), source.replace(/\s/g, ''));
    assert(chunks.every(part => !/[\uD800-\uDBFF]$/.test(part)));
    assert.deepEqual(phrases(' *** '), []);
    assert.equal(supported({}), false);
}

async function testBrowserSpeechPausePreviewAndCancellation() {
    const {speech, calls} = player();
    speech.voiceId = 'local'; speech.rate = 1.5; speech.pitch = 0.75;
    speech.play();
    assert.equal(calls[0].voice.voiceURI, 'local'); assert.equal(calls[0].lang, 'en-US');
    assert.equal(calls[0].rate, 1.5); assert.equal(calls[0].pitch, 0.75);
    speech.pause(); calls[0].onend();
    assert.equal(speech.index, 0); assert.equal(calls.length, 1, 'A cancelled phrase must not advance the book');
    speech.play(); calls[1].onend();
    assert.equal(calls[2].text, 'Вторая фраза.');
    speech.sample(); const sample = calls[calls.length - 1]; sample.onend();
    assert.equal(speech.index, 1, 'Preview must not change the book position');
    assert.equal(speech.status, 'paused');
    speech.play(); calls[calls.length - 1].onend(); assert.equal(speech.status, 'ended');
    speech.play(); assert.equal(speech.index, 0, 'Replay starts at the beginning');
    const stale = calls[calls.length - 1]; speech.setParts([{text: 'Другая книга'}]);
    stale.onerror({error: 'interrupted'}); stale.onend();
    assert.equal(speech.status, 'idle'); assert.equal(speech.index, 0);
}

async function testBrowserSpeechFailureAndNavigation() {
    const {speech, calls, states} = player();
    speech.seek(1); assert.equal(calls.length, 0, 'Seeking while paused must not start speech');
    speech.play(); speech.seek(0); assert.equal(calls[calls.length - 1].text, 'Первая фраза.');
    calls[calls.length - 1].onerror({error: 'network'});
    assert.equal(speech.status, 'paused'); assert(states[states.length - 1].error.includes('голос'));
    assert.throws(() => speech.locate({textSnippet: 'Отсутствующий текст'}));
    speech.stop();
    const empty = player([]); empty.speech.play(); assert.equal(empty.calls.length, 0);
}

module.exports = [testBrowserSpeechBoundedPhrases, testBrowserSpeechPausePreviewAndCancellation, testBrowserSpeechFailureAndNavigation];
