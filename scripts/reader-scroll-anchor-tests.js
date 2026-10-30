const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

function readerFixture() {
    const source = fs.readFileSync(path.join(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');
    function method(start, end) {
        const first = source.indexOf(start), last = source.indexOf(end, first);
        assert.ok(first >= 0 && last > first);
        return source.slice(first, last);
    }
    const methods = method('    captureScrollReflowAnchor() {', '    findTopLeftReaderContentNode(')
        + method('    restoreProgress() {', '    scheduleRestoreProgressRetry() {')
        + method('    onScroll() {', '    isReaderTapInteractiveTarget(');
    const text = {nodeType: 3, nodeValue: 'Начало абзаца. Здесь продолжается чтение внутри длинного раздела.', parentElement: {id: 'paragraph'}};
    const root = {contains: node => node === text, getBoundingClientRect: () => ({left: 20, right: 620})};
    const section = {offsetTop: 880};
    const scroller = {scrollTop: 1000, scrollHeight: 5000, clientHeight: 600,
        getBoundingClientRect: () => ({top: 100, left: 0, right: 640}),
        querySelector: selector => selector === '.reader-html' ? root : selector === '#section' ? section : null};
    let start;
    const document = {createRange: () => ({setStart: (node, offset) => { start = {node, offset}; }, setEnd() {},
        getBoundingClientRect: () => ({top: 410, height: 24}), detach() {}})};
    const Reader = new Function('document', 'Node', `return class {${methods}}`)(document, {TEXT_NODE: 3});
    const reader = new Reader();
    Object.assign(reader, {$refs: {scroller}, currentSectionId: 'section', activePreferences: {pagePaddingTop: 18},
        progress: {percent: .2, sectionId: 'section', textSnippet: 'Старая страница', textOffset: 300, pageIndex: 8},
        restorePending: true, restoreFromSavedProgress: true, isPagedMode: false,
        updateCurrentSectionFromScroll() {}, writeStoredReaderProgress() {}, saveProgressDebounced() {}, escapeCssId: value => value,
        getReaderTextPositionFromPoint: () => ({node: text, offset: 15}),
        getReaderTextSnippetFromPosition: (host, node, offset) => node.nodeValue.slice(offset), getReaderNodeAnchorId: node => node.id,
        findReaderTextPositionByDocumentSnippet: () => ({node: text, offset: 15}), findReaderTextPositionBySnippet: () => null});
    return {reader, scroller, text, start: () => start};
}

async function testScrollSavesVisibleTextInsteadOfStalePagedAnchor() {
    const {reader} = readerFixture();
    reader.onScroll();
    assert.equal(reader.progress.textSnippet, 'Здесь продолжается чтение внутри длинного раздела.');
    assert.equal(reader.progress.textOffset, -1);
    assert.equal(reader.progress.pageIndex, 0);
    reader.getReaderTextPositionFromPoint = () => null;
    reader.onScroll();
    assert.equal(reader.progress.textSnippet, '', 'A failed hit-test must clear an obsolete anchor');
}

async function testScrollRestoresInsideParagraphBeforeSectionFallback() {
    const {reader, scroller, text, start} = readerFixture();
    reader.restoreProgress();
    assert.deepEqual(start(), {node: text, offset: 15});
    assert.equal(scroller.scrollTop, 1292, 'Restore the precise text line, not the beginning of its section');
    assert.equal(reader.restorePending, false);
    reader.findReaderTextPositionByDocumentSnippet = () => null;
    reader.restorePending = true;
    reader.restoreFromSavedProgress = true;
    reader.restoreProgress();
    assert.equal(scroller.scrollTop, 862, 'Old or unavailable text anchors still restore their section');
}

module.exports = [testScrollSavesVisibleTextInsteadOfStalePagedAnchor, testScrollRestoresInsideParagraphBeforeSectionFallback];
