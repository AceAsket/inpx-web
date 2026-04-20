<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center">
                <div style="font-size: 110%">
                    Информация о книге
                </div>
            </div>
        </template>

        <div ref="box" class="fit column q-mt-xs overflow-auto no-wrap info-box">
            <div v-if="bookAuthor" class="text-green-10 info-link" @click.stop.prevent="emitNavigate('author', book.author)">
                {{ bookAuthor }}
            </div>
            <div>
                <b class="info-link" @click.stop.prevent="emitNavigate('title', book.title)">{{ book.title }}</b>
            </div>
            <div v-if="book.series" class="q-mt-xs info-series-link" @click.stop.prevent="emitNavigate('series', book.series)">
                {{ seriesLabel }}: {{ book.series }}<span v-if="book.serno"> #{{ book.serno }}</span>
            </div>

            <div class="row q-mt-sm no-wrap">
                <div class="poster-size">
                    <div class="column justify-center items-center" :class="{'poster': coverSrc, 'no-poster': !coverSrc}" @click.stop.prevent="posterClick">
                        <img v-if="coverSrc" :src="coverSrc" class="poster-image fit row justify-center items-center" @error="onCoverError" />
                        <div v-else class="poster-placeholder">
                            <div class="poster-letter">
                                {{ posterLetter }}
                            </div>
                            <div class="poster-title">
                                {{ posterTitle }}
                            </div>
                            <div class="poster-ext">
                                {{ posterExt }}
                            </div>
                        </div>
                    </div>
                </div>

                <div class="col column q-ml-sm info-panel">
                    <div class="bg-grey-3 row">
                        <q-tabs
                            v-model="selectedTab"
                            active-color="black"
                            active-bg-color="white"
                            indicator-color="white"
                            dense
                            no-caps
                            inline-label
                            class="bg-grey-4 text-grey-7"
                        >
                            <q-tab v-if="fb2.length" name="fb2" label="Fb2 info" />
                            <q-tab name="inpx" label="Inpx info" />
                            <q-tab v-if="hasAuthorTab" name="author" :label="authorTabLabel" />
                        </q-tabs>
                    </div>

                    <div class="overflow-auto full-width info-scroll">
                        <template v-if="selectedTab == 'author'">
                            <div class="author-tab-wrap">
                                <div v-if="authorInfoLoading" class="author-info-panel">
                                    <div class="author-info-head">
                                        Об авторе
                                    </div>
                                    <div class="row items-center text-grey-7">
                                        <q-icon class="la la-spinner icon-rotate text-green-8" size="24px" />
                                        <div class="q-ml-sm">
                                            Загрузка информации об авторе...
                                        </div>
                                    </div>
                                </div>

                                <div v-else-if="authorInfo" class="author-info-panel">
                                    <div class="author-info-head">
                                        Об авторе
                                    </div>
                                    <div class="row no-wrap author-info-body">
                                        <div v-if="authorInfo.photo" class="author-photo-box">
                                            <img :src="authorInfo.photo" class="author-photo" />
                                        </div>
                                        <div class="col author-info-html" v-html="authorInfo.html"></div>
                                    </div>
                                </div>

                                <div v-else class="author-empty-state">
                                    {{ noAuthorInfoLabel }}
                                </div>
                            </div>
                        </template>

                        <template v-else>
                            <div v-for="item in info" :key="item.name">
                                <div class="row q-ml-sm q-mt-sm items-center">
                                    <div class="text-blue section-label">
                                        {{ item.label }}
                                    </div>
                                    <div class="col q-mx-xs section-divider"></div>
                                </div>

                                <div v-for="subItem in item.value" :key="subItem.name" class="row q-ml-md info-row">
                                    <div class="info-key">
                                        {{ subItem.label }}
                                    </div>
                                    <div class="q-ml-sm info-value" v-html="subItem.value" />
                                </div>
                            </div>

                            <div v-if="selectedTab == 'fb2' && contents.length" class="fb2-contents q-mx-sm q-mt-md q-mb-sm">
                                <div class="text-blue section-label q-mb-sm">
                                    Содержание
                                </div>
                                <div class="fb2-contents-list">
                                    <div
                                        v-for="(item, index) in contents"
                                        :key="`toc-${index}`"
                                        class="fb2-contents-item"
                                        :style="{paddingLeft: `${item.level * 14}px`}"
                                    >
                                        <span class="fb2-contents-bullet">•</span>
                                        <span class="fb2-contents-title">{{ item.title }}</span>
                                    </div>
                                </div>
                            </div>

                            <div v-if="selectedTab == 'fb2' && fb2Images.length" class="fb2-gallery q-mx-sm q-mt-md q-mb-sm">
                                <div class="text-blue section-label q-mb-sm">
                                    Иллюстрации
                                </div>
                                <div class="fb2-gallery-grid">
                                    <img
                                        v-for="image in fb2Images"
                                        :key="image.id"
                                        :src="image.src"
                                        :alt="`fb2-${image.id}`"
                                        class="fb2-gallery-image"
                                    />
                                </div>
                            </div>
                        </template>

                        <div class="q-mt-xs"></div>
                    </div>
                </div>
            </div>

            <div v-if="selectedTab != 'author'" class="q-mt-md" v-html="annotation" />
        </div>

        <template #footer>
            <q-btn class="q-px-md q-ml-sm" color="primary" dense no-caps @click="okClick">
                OK
            </q-btn>
        </template>

        <Dialog v-model="posterDialogVisible">
            <template #header>
                <div class="row items-center">
                    <div style="font-size: 110%">
                        Обложка
                    </div>
                </div>
            </template>

            <img :src="coverSrc" class="fit q-pb-sm" style="height: 100%; max-height: calc(100vh - 140px); object-fit: contain" />
        </Dialog>
    </Dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import Dialog from '../../share/Dialog.vue';
import Fb2Parser from '../../../../server/core/fb2/Fb2Parser';
import * as utils from '../../../share/utils';
import _ from 'lodash';

const componentOptions = {
    components: {
        Dialog
    },
    emits: ['update:modelValue', 'navigate'],
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
            if (newValue)
                this.init();
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },
    }
};
class BookInfoDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
        bookInfo: Object,
        genreMap: Object,
        initialTab: {type: String, default: 'fb2'},
    };

    dialogVisible = false;
    posterDialogVisible = false;
    selectedTab = 'fb2';

    coverSrc = '';
    coverError = false;
    annotation = '';
    fb2 = [];
    contents = [];
    fb2Images = [];
    book = {};
    authorInfo = null;
    authorInfoLoading = false;

    created() {
        this.commit = this.$store.commit;
    }

    init() {
        this.coverSrc = '';
        this.coverError = false;
        this.annotation = '';
        this.fb2 = [];
        this.contents = [];
        this.fb2Images = [];
        this.book = {};
        this.authorInfo = null;
        this.authorInfoLoading = false;

        this.parseBookInfo();
        this.selectedTab = this.resolveInitialTab();
        this.loadAuthorInfo();//no await

        if (!this.fb2.length && this.selectedTab == 'fb2')
            this.selectedTab = 'inpx';
    }

    get config() {
        return this.$store.state.config;
    }

    get bookAuthor() {
        if (this.book.author) {
            const a = this.book.author.split(',');
            return a.slice(0, 3).join(', ') + (a.length > 3 ? ' и др.' : '');
        }

        return '';
    }

    get posterTitle() {
        return this.book.title || this.bookAuthor || 'Без названия';
    }

    get posterLetter() {
        return this.posterTitle.substring(0, 1).toUpperCase();
    }

    get posterExt() {
        return (this.book.ext || 'book').toUpperCase();
    }

    get seriesLabel() {
        return 'Серия';
    }

    get authorTabLabel() {
        return 'Об авторе';
    }

    get noAuthorInfoLabel() {
        return 'Информация об авторе не найдена.';
    }

    get hasAuthorTab() {
        return Boolean(this.book.author || this.authorInfo || this.authorInfoLoading);
    }

    get fallbackCoverSrc() {
        if (this.coverError || !this.book.libid)
            return '';

        const root = this.config.rootPathStatic || '';
        return `${root}/cover/${this.book.libid}`;
    }

    formatSize(size) {
        size = size/1024;
        let unit = 'KB';
        if (size > 1024) {
            size = size/1024;
            unit = 'MB';
        }
        return `${size.toFixed(1)} ${unit}`;
    }

    convertGenres(genreArr) {
        let result = [];
        if (genreArr) {
            for (const genre of genreArr) {
                const g = genre.trim();
                const name = this.genreMap.get(g);
                result.push(name ? name : g);
            }
        }

        return result.join(', ');
    }

    get inpx() {
        const mapping = [
            {name: 'fileInfo', label: 'Информация о файле', value: [
                {name: 'folder', label: 'Архив'},
                {name: 'file', label: 'Файл в архиве'},
                {name: 'size', label: 'Размер'},
                {name: 'date', label: 'Добавлен'},
                {name: 'del', label: 'Удален'},
                {name: 'libid', label: 'LibId'},
                {name: 'insno', label: 'InsideNo'},
            ]},
            {name: 'titleInfo', label: 'Общая информация', value: [
                {name: 'author', label: 'Автор(ы)'},
                {name: 'title', label: 'Название'},
                {name: 'series', label: 'Серия'},
                {name: 'genre', label: 'Жанр'},
                {name: 'librate', label: 'Оценка'},
                {name: 'lang', label: 'Язык книги'},
                {name: 'keywords', label: 'Ключевые слова'},
            ]},
        ];

        const valueToString = (value, nodePath, b) => {
            if (nodePath == 'fileInfo/file')
                return `${value}.${b.ext}`;

            if (nodePath == 'fileInfo/folder')
                return value;

            if (nodePath == 'fileInfo/size')
                return `${this.formatSize(value)} (${value.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1 ')} Bytes)`;

            if (nodePath == 'fileInfo/date')
                return utils.sqlDateFormat(value);

            if (nodePath == 'fileInfo/del')
                return (value ? 'Да' : null);

            if (nodePath == 'fileInfo/insno')
                return (value ? value : null);

            if (nodePath == 'titleInfo/author')
                return value.split(',').join(', ');

            if (nodePath == 'titleInfo/genre')
                return this.convertGenres(value.split(','));

            if (nodePath == 'titleInfo/librate' && !value)
                return null;

            if (typeof(value) === 'string')
                return value;

            return (value && value.toString ? value.toString() : '');
        };

        const result = [];
        const book = _.cloneDeep(this.book);
        book.series = [book.series, book.serno].filter(v => v).join(' #');

        for (const item of mapping) {
            const itemOut = {name: item.name, label: item.label, value: []};

            for (const subItem of item.value) {
                const subItemOut = {
                    name: subItem.name,
                    label: subItem.label,
                    value: valueToString(book[subItem.name], `${item.name}/${subItem.name}`, book)
                };
                if (subItemOut.value)
                    itemOut.value.push(subItemOut);
            }

            if (itemOut.value.length)
                result.push(itemOut);
        }

        return result;
    }

    get info() {
        switch (this.selectedTab) {
            case 'fb2':
                return this.fb2;
            case 'inpx':
                return this.inpx;
        }

        return [];
    }

    resolveInitialTab() {
        if (this.initialTab == 'author' && this.hasAuthorTab)
            return 'author';

        if (this.initialTab == 'inpx')
            return 'inpx';

        return 'fb2';
    }

    normalizeBinaryType(contentType = '') {
        let type = (contentType || '').toLowerCase();
        if (type == 'image/jpg' || type == 'application/octet-stream')
            type = 'image/jpeg';

        return type;
    }

    extractFb2Images(parser) {
        const result = [];
        const coverNode = parser.$$('/description/title-info/coverpage/image');
        let coverId = '';

        if (coverNode && coverNode.count) {
            const attrs = coverNode.attrs() || {};
            const href = attrs[`${parser.xlinkNS}:href`];
            if (href)
                coverId = (href[0] == '#' ? href.substring(1) : href);
        }

        for (const node of parser.$$array('/binary')) {
            const attrs = (node.attrs() || {});
            const id = attrs.id;
            const contentType = this.normalizeBinaryType(attrs['content-type']);
            const base64 = node.text();

            if (!id || !base64 || !contentType.startsWith('image/'))
                continue;
            if (id === coverId)
                continue;

            result.push({
                id,
                src: `data:${contentType};base64,${base64}`,
            });
        }

        return result.slice(0, 18);
    }

    replaceInlineFb2Images(html) {
        if (!html || !this.fb2Images.length)
            return html;

        const imageMap = new Map(this.fb2Images.map(item => [String(item.id), item.src]));
        return html.replace(/<image\b[^>]*href=["']#([^"']+)["'][^>]*\/?>/gi, (match, id) => {
            const src = imageMap.get(String(id));
            if (!src)
                return '';

            return `<img src="${src}" class="fb2-inline-image" alt="fb2-${id}">`;
        });
    }

    parseBookInfo() {
        const bookInfo = this.bookInfo || {};
        this.authorInfo = (bookInfo.authorInfo ? bookInfo.authorInfo : null);

        if (bookInfo.cover)
            this.coverSrc = bookInfo.cover;

        if (bookInfo.fb2) {
            const parser = new Fb2Parser(bookInfo.fb2);
            const infoObj = parser.bookInfo();
            this.fb2Images = this.extractFb2Images(parser);

            if (infoObj.titleInfo) {
                let ann = infoObj.titleInfo.annotationHtml;
                if (ann) {
                    ann = this.replaceInlineFb2Images(ann);
                    ann = ann.replace(/<p>/g, `<p class="p-annotation">`);
                    this.annotation = ann;
                }
            }

            this.fb2 = parser.bookInfoList(infoObj, {
                valueToString: (value, nodePath, origVTS) => {
                    if (nodePath == 'documentInfo/historyHtml' && value)
                        return this.replaceInlineFb2Images(value).replace(/<p>/g, `<p class="p-history">`);

                    if ((nodePath == 'titleInfo/genre' || nodePath == 'srcTitleInfo/genre') && value)
                        return this.convertGenres(value);

                    return origVTS(value, nodePath);
                },
            });

            this.contents = this.extractContents(parser);
        }

        if (bookInfo.book)
            this.book = bookInfo.book;

        if (!this.coverSrc && this.fallbackCoverSrc)
            this.coverSrc = this.fallbackCoverSrc;
    }

    async loadAuthorInfo() {
        if (this.authorInfo || !this.book.author)
            return;

        const firstAuthor = this.book.author.split(',').map(item => item.trim()).filter(Boolean)[0];
        if (!firstAuthor)
            return;

        this.authorInfoLoading = true;
        try {
            const response = await this.$root.api.getAuthorInfo(0, firstAuthor);
            this.authorInfo = (response && response.authorInfo ? response.authorInfo : null);
        } catch(e) {
            this.authorInfo = null;
        } finally {
            this.authorInfoLoading = false;
        }
    }

    extractContents(parser) {
        const result = [];

        const walk = (sections, level = 0) => {
            for (const section of sections) {
                const titleNode = section.$$('title/');
                let title = '';
                if (titleNode && titleNode.count)
                    title = titleNode.concat().replace(/\s+/g, ' ').trim();

                if (title)
                    result.push({title, level});

                const childSections = section.$$array('section');
                if (childSections.length)
                    walk(childSections, level + 1);
            }
        };

        for (const body of parser.$$array('/body'))
            walk(body.$$array('section'));

        return result.slice(0, 200);
    }

    posterClick() {
        if (!this.coverSrc)
            return;

        this.posterDialogVisible = true;
    }

    okClick() {
        this.dialogVisible = false;
    }

    onCoverError() {
        if (this.coverSrc && this.coverSrc !== this.fallbackCoverSrc && this.fallbackCoverSrc) {
            this.coverSrc = this.fallbackCoverSrc;
            return;
        }

        this.coverError = true;
        this.coverSrc = '';
    }

    emitNavigate(type, value) {
        if (!value)
            return;

        this.dialogVisible = false;
        this.$emit('navigate', {type, value});
    }
}

export default vueComponent(BookInfoDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.info-box {
    padding: 0 10px 10px;
}

.poster-size {
    height: 300px;
    width: 200px;
    min-width: 100px;
}

.info-link {
    cursor: pointer;
}

.info-series-link {
    color: var(--app-muted);
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
}

.info-panel {
    min-width: 400px;
    border: 1px solid #ccc;
}

.info-scroll {
    height: 262px;
}

.author-tab-wrap {
    padding: 12px;
}

.fb2-gallery {
    border-top: 1px solid #ccc;
    padding-top: 12px;
}

.fb2-contents {
    border-top: 1px solid #ccc;
    padding-top: 12px;
}

.fb2-contents-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.fb2-contents-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--app-text);
    font-size: 13px;
    line-height: 1.35;
}

.fb2-contents-bullet {
    color: var(--app-link);
    flex: 0 0 auto;
}

.fb2-contents-title {
    min-width: 0;
}

.fb2-gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 10px;
}

.fb2-gallery-image {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 4;
    object-fit: cover;
    border-radius: 12px;
    background: var(--app-surface-2);
    box-shadow: 0 6px 18px rgba(23, 32, 38, 0.10);
}

.section-label {
    font-size: 90%;
}

.section-divider {
    height: 0;
    border-top: 1px solid #ccc;
}

.info-row {
    align-items: flex-start;
}

.info-key {
    width: 100px;
    white-space: pre-wrap;
}

.info-value {
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
}

.poster,
.no-poster {
    width: 100%;
    height: 100%;
}

.poster {
    border-radius: 8px;
    overflow: hidden;
}

.no-poster {
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, var(--app-primary));
    border-radius: 8px;
    overflow: hidden;
}

.poster-image {
    object-fit: contain;
}

.poster:hover {
    position: relative;
    top: -1%;
    left: -1%;
    width: 102%;
    height: 102%;
    cursor: pointer;
}

.poster-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 18px;
    text-align: center;
    color: var(--app-text);
    background:
        radial-gradient(circle at 30% 22%, rgba(255, 255, 255, 0.56), transparent 28%),
        linear-gradient(145deg, rgba(15, 159, 143, 0.22), rgba(232, 93, 117, 0.16)),
        var(--app-surface-2);
}

.poster-letter {
    width: 76px;
    height: 76px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.72);
    color: var(--app-primary);
    font-size: 42px;
    font-weight: 800;
    box-shadow: 0 12px 26px rgba(23, 32, 38, 0.12);
}

.poster-title {
    font-size: 14px;
    font-weight: 750;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.poster-ext {
    padding: 4px 10px;
    border-radius: 8px;
    background: rgba(15, 23, 26, 0.08);
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0;
}

.author-info-panel {
    padding: 16px;
    border: 1px solid color-mix(in srgb, var(--app-border) 84%, var(--app-primary));
    border-radius: 16px;
    background:
        radial-gradient(circle at top right, rgba(15, 159, 143, 0.08), transparent 30%),
        linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.03)),
        var(--app-surface);
}

.author-info-head {
    margin-bottom: 10px;
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
}

.author-info-body {
    gap: 16px;
}

.author-photo-box {
    width: 110px;
    min-width: 110px;
}

.author-photo {
    display: block;
    width: 110px;
    height: 146px;
    border-radius: 14px;
    object-fit: cover;
    box-shadow: 0 10px 24px rgba(23, 32, 38, 0.12);
}

.author-info-html {
    min-width: 0;
    line-height: 1.55;
    word-break: break-word;
}

.author-info-html :deep(a) {
    color: var(--app-link);
}

.author-empty-state {
    padding: 18px;
    border: 1px dashed color-mix(in srgb, var(--app-border) 78%, var(--app-primary));
    border-radius: 16px;
    color: var(--app-muted);
    background: rgba(15, 159, 143, 0.04);
}

@media (max-width: 820px) {
    .info-box > .row.q-mt-sm.no-wrap {
        flex-wrap: wrap;
    }

    .poster-size {
        width: 140px;
        height: 210px;
        min-width: 140px;
    }

    .info-panel {
        min-width: 0;
        width: 100%;
        margin-left: 0 !important;
        margin-top: 12px;
    }

    .info-scroll {
        height: auto;
        max-height: 46vh;
    }

    .author-info-body {
        flex-wrap: wrap;
    }

    .author-photo-box,
    .author-photo {
        width: 92px;
        min-width: 92px;
        height: 122px;
    }
}

@media (max-width: 560px) {
    .info-box {
        padding: 0 6px 10px;
    }

    .poster-size {
        width: 100%;
        height: auto;
        min-width: 0;
    }

    .poster,
    .no-poster {
        min-height: 220px;
    }

    .poster-title {
        font-size: 13px;
    }

    .info-panel {
        border-radius: 14px;
        overflow: hidden;
    }

    .info-scroll {
        max-height: none;
    }

    .info-key {
        width: 82px;
        font-size: 12px;
    }

    .info-value {
        font-size: 13px;
    }

    .fb2-gallery-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
    }

    .author-tab-wrap {
        padding: 10px;
    }
}
</style>

<style>
.p-annotation {
    text-indent: 20px;
    text-align: justify;
    padding: 0;
    margin: 0;
}

.p-history {
    padding: 0;
    margin: 0;
}

.fb2-inline-image {
    display: block;
    max-width: min(100%, 360px);
    height: auto;
    margin: 12px 0;
    border-radius: 12px;
    box-shadow: 0 10px 24px rgba(23, 32, 38, 0.12);
}
</style>
