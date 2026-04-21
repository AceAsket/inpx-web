<template>
    <div
        ref="page"
        class="reader-page"
        :class="[readerThemeClass, {'reader-page--immersive': compactChromeHidden}]"
    >
        <div v-show="!compactChromeHidden" class="reader-toolbar">
            <div class="reader-toolbar-main">
                <q-btn
                    flat
                    no-caps
                    icon="la la-arrow-left"
                    @click="goBack"
                >
                    Назад
                </q-btn>

                <div class="reader-book-meta">
                    <div class="reader-book-title">
                        {{ title }}
                    </div>
                    <div class="reader-book-author">
                        {{ authorLine }}
                    </div>
                </div>

                <div class="reader-toolbar-quick-actions">
                    <q-btn
                        v-if="hasContents"
                        flat
                        dense
                        round
                        icon="la la-list"
                        class="reader-icon-btn"
                        @click="toggleContentsDialog"
                    />
                    <q-btn
                        flat
                        dense
                        round
                        :icon="fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                        class="reader-icon-btn"
                        @click="toggleFullscreen"
                    />
                    <q-btn
                        flat
                        dense
                        round
                        icon="la la-sliders-h"
                        class="reader-icon-btn"
                        :class="{'is-active': controlsOpen}"
                        @click="toggleControls"
                    />
                </div>
            </div>

            <div v-show="showToolbarActions" class="reader-toolbar-actions">
                <div class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'dark'}" @click="setTheme('dark')">Тёмная</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'sepia'}" @click="setTheme('sepia')">Сепия</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'light'}" @click="setTheme('light')">Светлая</q-btn>
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-minus" @click="changeFontSize(-1)" />
                    <div class="reader-stepper-value">{{ preferences.fontSize }}px</div>
                    <q-btn flat dense round icon="la la-plus" @click="changeFontSize(1)" />
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-compress" @click="changeContentWidth(-40)" />
                    <div class="reader-stepper-value">{{ preferences.contentWidth }}px</div>
                    <q-btn flat dense round icon="la la-expand" @click="changeContentWidth(40)" />
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-minus" @click="changeLineHeight(-0.05)" />
                    <div class="reader-stepper-value">{{ preferences.lineHeight.toFixed(2) }}</div>
                    <q-btn flat dense round icon="la la-plus" @click="changeLineHeight(0.05)" />
                </div>

                <div class="reader-progress-text">
                    {{ progressPercent }}%
                </div>
            </div>
        </div>

        <div v-if="loading" class="reader-loading">
            <q-icon class="la la-spinner icon-rotate text-green-8" size="28px" />
            <div class="q-ml-sm">Подготовка книги...</div>
        </div>

        <div v-else-if="error" class="reader-error">
            {{ error }}
        </div>

        <div
            v-else
            ref="scroller"
            class="reader-scroll"
            @scroll="onScroll"
            @click="handleReaderTap"
        >
            <div class="reader-shell">
                <div v-if="coverSrc" class="reader-cover-box">
                    <img :src="coverSrc" class="reader-cover" :alt="title" />
                </div>

                <div class="reader-body" :style="readerBodyStyle">
                    <div v-if="seriesLine" class="reader-series">
                        {{ seriesLine }}
                    </div>
                    <h1 class="reader-heading">
                        {{ title }}
                    </h1>
                    <div v-if="authorLine" class="reader-subheading">
                        {{ authorLine }}
                    </div>

                    <div v-if="hasContents && !isCompactLayout" class="reader-contents-inline">
                        <div class="reader-contents-inline-title">
                            Содержание
                        </div>
                        <div class="reader-contents-inline-list">
                            <button
                                v-for="item in inlineContents"
                                :key="item.id"
                                class="reader-contents-chip"
                                @click="jumpToContent(item.id)"
                            >
                                {{ item.title }}
                            </button>
                        </div>
                    </div>

                    <div class="reader-progress-bar">
                        <div class="reader-progress-bar-fill" :style="{width: `${progressPercent}%`}"></div>
                    </div>

                    <div class="reader-html" v-html="readerHtml"></div>
                </div>
            </div>
        </div>

        <div v-if="isCompactLayout && !compactChromeHidden" class="reader-mobile-bar">
            <q-btn
                v-if="hasContents"
                flat
                no-caps
                icon="la la-list"
                class="reader-mobile-btn"
                @click="toggleContentsDialog"
            >
                Содержание
            </q-btn>
            <q-btn
                flat
                no-caps
                icon="la la-sliders-h"
                class="reader-mobile-btn"
                :class="{'is-active': controlsOpen}"
                @click="toggleControls"
            >
                Настройки
            </q-btn>
            <q-btn
                flat
                no-caps
                :icon="fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                class="reader-mobile-btn"
                @click="toggleFullscreen"
            >
                Экран
            </q-btn>
        </div>

        <div v-if="compactChromeHidden && isCompactLayout" class="reader-tap-hint">
            {{ currentSectionTitle || `${progressPercent}%` }}
        </div>

        <q-dialog v-model="contentsDialogOpen" position="right">
            <div class="reader-dialog reader-dialog--contents">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">Содержание</div>
                    <q-btn flat dense round icon="la la-times" @click="contentsDialogOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <button
                        v-for="item in displayContents"
                        :key="item.id"
                        class="reader-dialog-link"
                        :class="{'is-active': item.id === currentSectionId}"
                        @click="jumpToContent(item.id)"
                    >
                        {{ item.title }}
                    </button>
                </div>
            </div>
        </q-dialog>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import Fb2Parser from '../../../server/core/fb2/Fb2Parser';
import _ from 'lodash';

const componentOptions = {
    watch: {
        '$route.query.bookUid': {
            immediate: true,
            handler() {
                this.loadReader();// no await
            },
        },
    },
};

class Reader {
    _options = componentOptions;

    loading = false;
    error = '';
    bookInfo = null;
    title = '';
    authorLine = '';
    seriesLine = '';
    coverSrc = '';
    readerHtml = '';
    controlsOpen = false;
    contentsDialogOpen = false;
    fullscreenActive = false;
    chromeHidden = false;
    contents = [];
    currentSectionId = '';
    preferences = {
        theme: 'dark',
        fontSize: 18,
        lineHeight: 1.7,
        contentWidth: 820,
    };
    progress = {
        percent: 0,
        sectionId: '',
        updatedAt: '',
    };
    restorePending = false;
    saveProgressDebounced = null;
    savePreferencesDebounced = null;

    created() {
        this.api = this.$root.api;
        this.handleBeforeUnload = () => {
            this.flushProgress();
        };
        this.handleFullscreenChange = () => {
            this.fullscreenActive = !!document.fullscreenElement;
        };

        this.saveProgressDebounced = _.debounce(() => {
            this.persistProgress();// no await
        }, 800);

        this.savePreferencesDebounced = _.debounce(() => {
            this.persistPreferences();// no await
        }, 500);
    }

    mounted() {
        window.addEventListener('beforeunload', this.handleBeforeUnload);
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);
        this.handleFullscreenChange();
    }

    deactivated() {
        this.flushProgress();
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    beforeUnmount() {
        window.removeEventListener('beforeunload', this.handleBeforeUnload);
        document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
        this.flushProgress();
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    get bookUid() {
        return String(this.$route.query.bookUid || this.$route.params.bookUid || '').trim();
    }

    get readerThemeClass() {
        return `reader-theme-${this.preferences.theme || 'dark'}`;
    }

    get progressPercent() {
        return Math.round((Number(this.progress.percent || 0) || 0) * 100);
    }

    get readerBodyStyle() {
        return {
            '--reader-font-size': `${this.preferences.fontSize}px`,
            '--reader-line-height': String(this.preferences.lineHeight),
            '--reader-content-width': `${this.preferences.contentWidth}px`,
        };
    }

    get isCompactLayout() {
        return !!(this.$q && this.$q.screen && this.$q.screen.lt && this.$q.screen.lt.md);
    }

    get compactChromeHidden() {
        return this.isCompactLayout && this.chromeHidden;
    }

    get showToolbarActions() {
        return !this.isCompactLayout || this.controlsOpen;
    }

    get displayContents() {
        return this.contents.slice(0, 120);
    }

    get inlineContents() {
        return this.displayContents.slice(0, 12);
    }

    get hasContents() {
        return this.displayContents.length > 0;
    }

    get currentSectionTitle() {
        const current = this.contents.find((item) => item.id === this.currentSectionId);
        return (current ? current.title : '');
    }

    goBack() {
        if (window.history.length > 1)
            this.$router.back();
        else
            this.$router.push('/');
    }

    toggleControls() {
        this.controlsOpen = !this.controlsOpen;
    }

    toggleContentsDialog() {
        this.contentsDialogOpen = !this.contentsDialogOpen;
    }

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (this.$refs.page && this.$refs.page.requestFullscreen) {
                await this.$refs.page.requestFullscreen();
            }
        } catch(e) {
            // ignore browser-specific fullscreen failures
        }
    }

    normalizeBinaryType(type = '') {
        let result = String(type || '').trim().toLowerCase();
        if (result === 'image/jpg' || result === 'application/octet-stream')
            result = 'image/jpeg';
        return result;
    }

    sanitizeContents(list = []) {
        return (Array.isArray(list) ? list : [])
            .map((item, index) => ({
                id: `section-${index + 1}`,
                title: String(item && item.title ? item.title : '').trim(),
            }))
            .filter((item) => item.title);
    }

    escapeCssId(id = '') {
        const value = String(id || '');
        if (typeof(CSS) !== 'undefined' && CSS.escape)
            return CSS.escape(value);
        return value.replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
    }

    extractImageMap(parser) {
        const result = new Map();
        for (const node of parser.$$array('/binary')) {
            const attrs = (node.attrs() || {});
            const id = attrs.id;
            const contentType = this.normalizeBinaryType(attrs['content-type']);
            const base64 = node.text();
            if (!id || !base64 || !contentType.startsWith('image/'))
                continue;

            result.set(String(id), `data:${contentType};base64,${base64}`);
        }
        return result;
    }

    replaceInlineImages(html, imageMap) {
        if (!html || !imageMap.size)
            return html;

        return html.replace(/<image\b[^>]*href=["']#([^"']+)["'][^>]*\/?>/gi, (match, id) => {
            const src = imageMap.get(String(id));
            if (!src)
                return '';

            return `<img src="${src}" class="reader-inline-image" alt="fb2-${id}">`;
        });
    }

    injectHeadingAnchors(html) {
        if (!html || !this.contents.length)
            return html;

        let index = 0;
        return html.replace(/<h([1-4])>/gi, (match, level) => {
            const item = this.contents[index++];
            if (!item)
                return `<h${level}>`;

            return `<h${level} id="${item.id}" class="reader-anchored-heading">`;
        });
    }

    buildReaderHtml(parser) {
        const parts = [];
        const imageMap = this.extractImageMap(parser);

        for (const body of parser.$$array('/body')) {
            const attrs = (body.attrs() || new Map());
            const bodyName = (attrs.get('name') || '').toLowerCase();
            const bodyXml = parser.newParser([body.raw]).toString({noHeader: true});
            let html = parser.toHtml(bodyXml);
            html = this.replaceInlineImages(html, imageMap);
            html = html.replace(/<p>/g, '<p class="reader-paragraph">');
            html = this.injectHeadingAnchors(html);

            if (bodyName === 'notes')
                parts.push(`<section class="reader-notes"><h2>Примечания</h2>${html}</section>`);
            else
                parts.push(`<section class="reader-section">${html}</section>`);
        }

        return parts.join('\n');
    }

    async loadReader() {
        if (!this.bookUid)
            return;

        this.loading = true;
        this.error = '';
        this.readerHtml = '';
        this.contents = [];
        this.currentSectionId = '';
        this.restorePending = false;
        this.controlsOpen = false;
        this.contentsDialogOpen = false;
        this.chromeHidden = false;

        try {
            const [bookResponse, stateResponse] = await Promise.all([
                this.api.getBookInfo(this.bookUid),
                this.api.getReaderState(this.bookUid),
            ]);

            this.bookInfo = (bookResponse ? bookResponse.bookInfo : null);
            const info = (this.bookInfo || {});
            const book = (info.book || {});
            if (!info.fb2)
                throw new Error('Встроенная читалка пока поддерживает только FB2.');

            const parser = new Fb2Parser(info.fb2);
            const fb2Info = parser.bookInfo();
            this.title = book.title || (fb2Info.titleInfo && fb2Info.titleInfo.bookTitle) || 'Без названия';
            this.authorLine = book.author || ((fb2Info.titleInfo && fb2Info.titleInfo.author) ? fb2Info.titleInfo.author.join(', ') : '');
            this.seriesLine = (book.series ? `${book.series}${book.serno ? ` #${book.serno}` : ''}` : '');
            this.coverSrc = info.cover || '';
            this.contents = this.sanitizeContents(info.contents || []);
            this.readerHtml = this.buildReaderHtml(parser);

            this.preferences = Object.assign({}, this.preferences, stateResponse.preferences || {});
            this.progress = Object.assign({percent: 0, sectionId: '', updatedAt: ''}, stateResponse.progress || {});
            this.currentSectionId = String(this.progress.sectionId || '').trim();
            this.restorePending = true;

            this.$root.setAppTitle(this.title);
            this.$nextTick(() => {
                requestAnimationFrame(() => this.restoreProgress());
            });
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
        }
    }

    restoreProgress() {
        if (!this.restorePending || !this.$refs.scroller)
            return;

        this.restorePending = false;
        const scroller = this.$refs.scroller;

        if (this.progress.sectionId) {
            const target = scroller.querySelector(`#${this.escapeCssId(this.progress.sectionId)}`);
            if (target) {
                scroller.scrollTop = Math.max(0, target.offsetTop - 18);
                this.updateCurrentSectionFromScroll();
                return;
            }
        }

        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = maxScroll * (Number(this.progress.percent || 0) || 0);
        this.updateCurrentSectionFromScroll();
    }

    updateCurrentSectionFromScroll() {
        if (!this.$refs.scroller || !this.contents.length)
            return;

        const scroller = this.$refs.scroller;
        let activeId = this.currentSectionId;

        for (const item of this.contents) {
            const target = scroller.querySelector(`#${this.escapeCssId(item.id)}`);
            if (!target)
                continue;

            if (target.offsetTop - scroller.scrollTop <= 80)
                activeId = item.id;
            else
                break;
        }

        this.currentSectionId = activeId || (this.contents[0] ? this.contents[0].id : '');
    }

    onScroll() {
        if (this.loading || !this.$refs.scroller)
            return;

        const scroller = this.$refs.scroller;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const percent = (maxScroll > 0 ? scroller.scrollTop / maxScroll : 0);
        this.updateCurrentSectionFromScroll();
        this.progress = Object.assign({}, this.progress, {
            percent,
            sectionId: this.currentSectionId || '',
        });
        this.saveProgressDebounced();
    }

    handleReaderTap(event) {
        if (!this.isCompactLayout || !this.$refs.scroller)
            return;

        const target = event.target;
        if (target && target.closest && target.closest('button, a, img, input, textarea, select, .q-btn, .reader-dialog'))
            return;

        const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
        if (selection)
            return;

        const rect = this.$refs.scroller.getBoundingClientRect();
        const relX = (event.clientX - rect.left) / rect.width;
        const relY = (event.clientY - rect.top) / rect.height;
        const isCenterTap = (relX >= 0.18 && relX <= 0.82 && relY >= 0.18 && relY <= 0.82);
        if (!isCenterTap)
            return;

        this.chromeHidden = !this.chromeHidden;
        if (this.chromeHidden) {
            this.controlsOpen = false;
            this.contentsDialogOpen = false;
        }
    }

    jumpToContent(id = '') {
        this.contentsDialogOpen = false;
        this.chromeHidden = false;
        if (!id || !this.$refs.scroller)
            return;

        this.$nextTick(() => {
            const scroller = this.$refs.scroller;
            const target = scroller.querySelector(`#${this.escapeCssId(id)}`);
            if (!target)
                return;

            this.currentSectionId = id;
            const top = Math.max(0, target.offsetTop - 18);
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    async persistProgress() {
        if (!this.bookUid)
            return;

        await this.api.updateReaderProgress(this.bookUid, {
            percent: Number(this.progress.percent || 0) || 0,
            sectionId: this.currentSectionId || '',
        });
    }

    async persistPreferences() {
        await this.api.updateReaderPreferences(this.preferences);
    }

    flushProgress() {
        if (this.saveProgressDebounced && this.saveProgressDebounced.flush)
            this.saveProgressDebounced.flush();
    }

    setTheme(theme) {
        this.preferences = Object.assign({}, this.preferences, {theme});
        this.savePreferencesDebounced();
    }

    changeFontSize(delta) {
        this.preferences = Object.assign({}, this.preferences, {
            fontSize: Math.max(14, Math.min(30, this.preferences.fontSize + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeContentWidth(delta) {
        this.preferences = Object.assign({}, this.preferences, {
            contentWidth: Math.max(560, Math.min(1200, this.preferences.contentWidth + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeLineHeight(delta) {
        const next = Math.round((this.preferences.lineHeight + delta) * 100) / 100;
        this.preferences = Object.assign({}, this.preferences, {
            lineHeight: Math.max(1.35, Math.min(2.2, next)),
        });
        this.savePreferencesDebounced();
    }
}

export default vueComponent(Reader);
</script>

<style scoped>
.reader-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 100%;
    background: var(--reader-bg);
    color: var(--reader-text);
}

.reader-page--immersive {
    cursor: default;
}

.reader-toolbar {
    position: sticky;
    top: 0;
    z-index: 12;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface) 92%, transparent);
    backdrop-filter: blur(10px);
}

.reader-toolbar-main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.reader-book-meta {
    min-width: 0;
}

.reader-book-title {
    font-size: 18px;
    font-weight: 750;
    line-height: 1.2;
}

.reader-book-author {
    margin-top: 2px;
    color: var(--reader-muted);
    font-size: 13px;
}

.reader-toolbar-quick-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}

.reader-icon-btn {
    border: 1px solid var(--reader-border);
    background: var(--reader-surface-2);
}

.reader-icon-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.reader-theme-switch,
.reader-stepper {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
}

.reader-theme-switch :deep(.q-btn.is-active) {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-stepper-value,
.reader-progress-text {
    min-width: 54px;
    text-align: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--reader-muted);
}

.reader-loading,
.reader-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.reader-scroll {
    flex: 1 1 auto;
    overflow: auto;
}

.reader-shell {
    padding: 28px 18px 96px;
}

.reader-cover-box {
    display: flex;
    justify-content: center;
    margin-bottom: 24px;
}

.reader-cover {
    width: 180px;
    max-width: 42vw;
    border-radius: 14px;
    box-shadow: 0 18px 38px rgba(0, 0, 0, 0.18);
}

.reader-body {
    width: min(100%, var(--reader-content-width));
    margin: 0 auto;
    font-size: var(--reader-font-size);
    line-height: var(--reader-line-height);
}

.reader-series {
    color: var(--reader-muted);
    font-size: 0.92em;
    font-weight: 650;
}

.reader-heading {
    margin: 10px 0 0;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.06;
}

.reader-subheading {
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 0.98em;
}

.reader-contents-inline {
    margin: 22px 0 0;
    padding: 14px 16px;
    border: 1px solid var(--reader-border);
    border-radius: 18px;
    background: color-mix(in srgb, var(--reader-surface) 82%, transparent);
}

.reader-contents-inline-title {
    font-size: 14px;
    font-weight: 750;
    color: var(--reader-muted);
}

.reader-contents-inline-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.reader-contents-chip {
    padding: 8px 12px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    cursor: pointer;
}

.reader-progress-bar {
    margin: 20px 0 28px;
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--reader-surface-2);
    overflow: hidden;
}

.reader-progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--reader-accent), color-mix(in srgb, var(--reader-accent) 72%, white));
}

.reader-html {
    color: var(--reader-text);
}

.reader-html :deep(h1),
.reader-html :deep(h2),
.reader-html :deep(h3),
.reader-html :deep(h4) {
    line-height: 1.15;
    margin: 1.45em 0 0.5em;
}

.reader-html :deep(.reader-anchored-heading) {
    scroll-margin-top: 84px;
}

.reader-html :deep(p),
.reader-paragraph {
    margin: 0.8em 0;
    text-align: justify;
}

.reader-html :deep(blockquote) {
    margin: 1.2em 0;
    padding-left: 1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(img),
.reader-inline-image {
    display: block;
    max-width: min(100%, 680px);
    height: auto;
    margin: 18px auto;
    border-radius: 12px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

.reader-notes {
    margin-top: 2.5em;
    padding-top: 1.5em;
    border-top: 1px solid var(--reader-border);
}

.reader-mobile-bar {
    position: sticky;
    bottom: 0;
    z-index: 14;
    display: flex;
    gap: 8px;
    padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    backdrop-filter: blur(12px);
}

.reader-mobile-btn {
    flex: 1 1 0;
    min-height: 42px;
    border: 1px solid var(--reader-border);
    border-radius: 14px;
    background: var(--reader-surface-2);
}

.reader-mobile-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-tap-hint {
    position: fixed;
    left: 50%;
    bottom: calc(18px + env(safe-area-inset-bottom));
    z-index: 15;
    transform: translateX(-50%);
    padding: 8px 14px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--reader-surface) 92%, transparent);
    color: var(--reader-muted);
    font-size: 13px;
    font-weight: 700;
    backdrop-filter: blur(10px);
}

.reader-dialog {
    width: min(92vw, 420px);
    max-height: 85vh;
    border-radius: 22px;
    background: var(--reader-surface);
    color: var(--reader-text);
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.reader-dialog--contents {
    overflow: hidden;
}

.reader-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--reader-border);
}

.reader-dialog-title {
    font-size: 18px;
    font-weight: 750;
}

.reader-dialog-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(85vh - 64px);
    overflow: auto;
    padding: 12px;
}

.reader-dialog-link {
    padding: 12px 14px;
    border: 1px solid var(--reader-border);
    border-radius: 14px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    text-align: left;
    cursor: pointer;
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-theme-dark {
    --reader-bg: #12171b;
    --reader-surface: #182127;
    --reader-surface-2: #222c33;
    --reader-text: #edf2f5;
    --reader-muted: #9db0bc;
    --reader-border: rgba(157, 176, 188, 0.22);
    --reader-accent: #5eead4;
    --reader-accent-soft: rgba(94, 234, 212, 0.12);
}

.reader-theme-sepia {
    --reader-bg: #f4ecdd;
    --reader-surface: #fbf6ec;
    --reader-surface-2: #efe4d2;
    --reader-text: #402f20;
    --reader-muted: #7c6855;
    --reader-border: rgba(64, 47, 32, 0.16);
    --reader-accent: #b76a2c;
    --reader-accent-soft: rgba(183, 106, 44, 0.12);
}

.reader-theme-light {
    --reader-bg: #f7fafc;
    --reader-surface: #ffffff;
    --reader-surface-2: #eef3f7;
    --reader-text: #1f2a33;
    --reader-muted: #60707d;
    --reader-border: rgba(96, 112, 125, 0.18);
    --reader-accent: #0f9f8f;
    --reader-accent-soft: rgba(15, 159, 143, 0.12);
}

@media (max-width: 900px) {
    .reader-toolbar {
        flex-direction: column;
        align-items: stretch;
    }

    .reader-toolbar-actions {
        justify-content: flex-start;
    }
}

@media (max-width: 640px) {
    .reader-toolbar {
        padding: 10px 10px 12px;
        gap: 10px;
    }

    .reader-toolbar-main {
        align-items: flex-start;
    }

    .reader-book-title {
        font-size: 16px;
    }

    .reader-toolbar-actions {
        gap: 8px;
        padding-top: 4px;
    }

    .reader-theme-switch,
    .reader-stepper {
        width: 100%;
        justify-content: center;
        border-radius: 14px;
        min-height: 44px;
    }

    .reader-progress-text {
        width: 100%;
        min-width: 0;
        text-align: left;
        padding-left: 4px;
    }

    .reader-shell {
        padding: 18px 10px 110px;
    }

    .reader-cover {
        width: 140px;
        max-width: 46vw;
    }

    .reader-body {
        width: 100%;
    }

    .reader-html :deep(p),
    .reader-paragraph {
        text-align: left;
    }
}
</style>
