const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

async function testReaderMeasuresCanonicalPageAcrossFullscreenTransitions() {
    const source = await fs.readFile(path.resolve(__dirname, '../client/components/Reader/Reader.vue'), 'utf8');
    const method = (start, end) => {
        const first = source.indexOf(start), last = source.indexOf(end, first);
        assert.ok(first >= 0 && last > first);
        return source.slice(first, last);
    };
    const methods = method('    getPagedStageRect() {', '    async waitForReaderFontsReady(') +
        method('    getPagedMeasureAvailableHeight(measureHost) {', '    get pagedContentSafetyInset() {') +
        method('    getFastPagedLineBudget(measureHost = null) {', '    getFastPagedColumnWidth() {');
    let stageHeight = 180;
    const host = {style: {}, clientWidth: 608};
    const html = {
        get clientHeight() { return Math.max(0, parseFloat(host.style.height || '180') - 42); },
        getBoundingClientRect() { return {height: this.clientHeight}; },
    };
    host.querySelector = () => html;
    host.getBoundingClientRect = () => ({height: parseFloat(host.style.height || '180')});
    Object.defineProperty(host, 'clientHeight', {get: () => parseFloat(host.style.height || '180')});
    const Reader = new Function('window', `return class {${methods}}`)({
        getComputedStyle: node => node === host ? {paddingTop: '18', paddingBottom: '22'} : {paddingTop: '0', paddingBottom: '0'},
    });
    const reader = new Reader();
    reader.$refs = {pageMeasure: host, pageStage: {getBoundingClientRect: () => ({width: 1244, height: stageHeight})}};
    reader.activePreferences = {fontSize: 18, lineHeight: 1.7};
    reader.isCompactLayout = false;
    reader.pageMeasureFrameWidth = 608;
    reader.currentDynamicBottomClipCompensation = 0;
    reader.readerDebug = {};
    for (const [canonical, previous] of [[520, 180], [1500, 520], [520, 1500]]) {
        reader.pageMinHeight = canonical;
        stageHeight = previous;
        assert.strictEqual(reader.getPagedMeasureAvailableHeight(host), canonical - 42,
            'Pagination must use the new page height even before Vue updates the visible stage');
        assert.strictEqual(host.style.height, `${canonical}px`);
        assert.strictEqual(host.style.minHeight, `${canonical}px`);
        assert.strictEqual(reader.getFastPagedLineBudget(host), Math.max(2, Math.floor((canonical - 42) / 31 - 0.35)));
        assert.strictEqual(host.style.width, '608px', 'Dual spread measurement keeps one column width');
    }
    reader.isCompactLayout = true;
    reader.pageMinHeight = 600;
    reader.currentDynamicBottomClipCompensation = 20;
    assert.strictEqual(reader.getPagedMeasureAvailableHeight(host), 538, 'Mobile bottom clipping compensation remains in effect');
}

module.exports = [testReaderMeasuresCanonicalPageAcrossFullscreenTransitions];
