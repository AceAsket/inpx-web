<template>
    <Dialog v-model="dialogVisible" variant="book">
        <template #header>Книга в библиотеке</template>
        <div class="library-book-actions">
            <a ref="download" style="display: none" />
            <LoadingMessage :message="loadingMessage2" />
            <div class="book-actions-summary">
                <BookCover :book="book" />
                <div>
                    <div class="book-actions-meta"><span>{{ sourceFormat }}</span><span v-if="sizeLabel">{{ sizeLabel }}</span><span v-if="dateLabel">{{ dateLabel }}</span></div>
                    <h2>{{ book.title || 'Без названия' }}</h2>
                    <button v-if="book.author" type="button" class="book-actions-author" @click="bookEvent({action: 'authorClick', book})">{{ book.author }}</button>
                    <button v-if="book.series" type="button" class="book-actions-series" @click="bookEvent({action: 'seriesClick', book})">{{ book.series }}<span v-if="book.serno"> · {{ book.serno }}</span></button>
                    <div v-if="percent !== null" class="book-actions-progress">{{ Math.round(percent * 100) }}% прочитано</div>
                </div>
            </div>
            <template v-if="!book.discoveryMissingLocal && !book.unavailable">
                <div class="book-actions-primary">
                    <q-btn v-if="canRead" color="primary" unelevated no-caps icon="la la-book-open" :label="readLabel" @click="bookEvent({action: 'readBook', book})" />
                    <a :href="getDirectBookDownloadHref(book, downloadFormat)" class="book-actions-download"><q-icon name="la la-download" size="20px" /> Скачать {{ downloadFormat === 'raw' ? sourceFormat : downloadFormat.toUpperCase() }}</a>
                </div>
                <q-select v-if="downloadFormats.length > 1" v-model="downloadFormat" outlined dense emit-value map-options :options="downloadFormats" label="Формат скачивания" class="book-actions-formats" />
                <div class="book-actions-secondary">
                    <button type="button" @click="$emit('details', book); dialogVisible = false"><q-icon name="la la-info-circle" /><span>Описание и сведения</span></button>
                    <button type="button" @click="bookEvent({action: 'readingList', book})"><q-icon name="la la-bookmark" /><span>Добавить на полку</span></button>
                    <button v-if="config.profileAuthorized" type="button" :disabled="updatingRead" @click="toggleRead"><q-icon :name="markedRead ? 'la la-undo' : 'la la-check-circle'" /><span>{{ markedRead ? 'Снять отметку' : 'Прочитано' }}</span></button>
                    <button type="button" :disabled="actionBusy" @click="perform('copyLink')"><q-icon name="la la-link" /><span>Копировать ссылку</span></button>
                    <button v-if="config.telegramShareEnabled" type="button" :disabled="actionBusy" @click="perform('sendTelegram')"><q-icon name="lab la-telegram-plane" /><span>Отправить в Telegram</span></button>
                    <button v-if="config.emailShareEnabled" type="button" :disabled="actionBusy" @click="perform('sendEmail')"><q-icon name="la la-envelope" /><span>Отправить по Email</span></button>
                </div>
            </template>
            <q-btn v-else-if="externalUrl" color="primary" no-caps unelevated label="Открыть источник" icon="la la-external-link-alt" :href="externalUrl" target="_blank" rel="noopener noreferrer" />
            <p v-else class="book-actions-unavailable">Книга сейчас недоступна в каталоге.</p>
        </div>
    </Dialog>
</template>

<script>
import vueComponent from '../vueComponent';
import BaseList from '../Search/BaseList';
import BookCover from './BookCover.vue';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import Dialog from '../share/Dialog.vue';
import {readable, progress} from './libraryModel';
const bookFormats = require('../../../shared/BookFormats');

// Use the same download, format, email, Telegram and read-state actions as the catalog.
// This adapter has no search lifecycle or parallel implementation of those operations.
class BookActionsDialog extends BaseList {
    _props = {modelValue: Boolean, book: Object, genreMap: Object};
    _options = {
        components: {Dialog, BookCover, LoadingMessage},
        emits: ['update:modelValue', 'listEvent', 'navigate', 'details', 'updated'],
        watch: {
            modelValue(value) {this.dialogVisible = value;},
            dialogVisible(value) {this.$emit('update:modelValue', value);},
            settings() {this.loadSettings();},
        },
    };
    dialogVisible = false;
    list = {liberamaReady: false};
    downloadFormat = 'raw';
    readOverride = null;
    updatingRead = false;
    actionBusy = false;

    created() {
        super.created();
        this.dialogVisible = this.modelValue;
        this.downloadFormat = bookFormats.resolve(this.book.ext, this.config, bookFormats.profilePreference(this.config)) || 'raw';
    }
    refresh() {}

    get sourceFormat() {return String(this.book.ext || 'Книга').toUpperCase();}
    get percent() {return progress(this.book);}
    get markedRead() {return this.readOverride ?? (this.book.state === 'read' || this.book._readingListRead === true || this.book.read === true || this.percent >= .999);}
    get canRead() {return readable(this.book, this.config) || (!this.book.unavailable && !!String(this.config.bookReadLink || '').trim());}
    get readLabel() {return readable(this.book, this.config) ? 'Читать' : 'Открыть в читалке';}
    get downloadFormats() {
        return [{label: `${this.sourceFormat} · Оригинал`, value: 'raw'}, ...bookFormats.available(this.book.ext, this.config)
            .filter(format => format !== String(this.book.ext).toLowerCase()).map(format => ({label: format.toUpperCase(), value: format}))];
    }
    get sizeLabel() {
        const size = Number(this.book.size) || 0;
        if (size <= 0) return '';
        return size >= 1048576 ? `${(size / 1048576).toFixed(1)} МБ` : size >= 1024 ? `${Math.round(size / 1024)} КБ` : `${size} Б`;
    }
    get dateLabel() {return /^\d{4}-\d{2}-\d{2}/.test(this.book.date || '') ? this.book.date.slice(0, 10).split('-').reverse().join('.') : '';}
    get externalUrl() {
        try {const url = new URL(this.book.discoveryUrl); return ['http:', 'https:'].includes(url.protocol) ? url.href : '';}
        catch {return '';}
    }
    async perform(action) {
        if (this.actionBusy) return;
        this.actionBusy = true;
        try {await this.download(this.book, action);}
        finally {this.actionBusy = false;}
    }
    async toggleRead() {
        if (this.updatingRead) return;
        this.updatingRead = true;
        try {await this.markBooksRead([this.getBookUid(this.book)], !this.markedRead);}
        finally {this.updatingRead = false;}
    }

    bookEvent(event) {
        const navigation = {authorClick: 'author', seriesClick: 'series', titleClick: 'title', genreClick: 'genre'};
        const type = navigation[event.action];
        if (type) {
            this.$emit('navigate', {type, value: type === 'genre' ? event.format : event.book[type]});
            this.dialogVisible = false;
            return;
        }
        if (['bookInfo', 'authorInfo'].includes(event.action)) {
            this.$emit('details', event.book);
            this.dialogVisible = false;
            return;
        }
        if (['readBook', 'readingList'].includes(event.action)) this.dialogVisible = false;
        super.bookEvent(event);
    }

    async markBooksRead(uids, read) {
        const saved = await super.markBooksRead(uids, read);
        if (saved) {this.readOverride = read; this.$emit('updated');}
        return saved;
    }
}
export default vueComponent(BookActionsDialog);
</script>

<style scoped>
.library-book-actions {position: relative; padding: 0;}
.book-actions-summary {display: flex; align-items: flex-start; gap: 22px;}
.book-actions-summary > :deep(.book-cover) {width: 104px; flex: 0 0 104px;}
.book-actions-summary > div {flex: 1; min-width: 0;}
.book-actions-meta {display: flex; gap: 10px; flex-wrap: wrap; color: var(--app-muted); font-size: 12px; margin: 2px 0 10px;}
h2 {font-size: 23px; font-weight: 550; line-height: 1.35; margin: 0 0 10px; overflow-wrap: anywhere;}
.book-actions-author, .book-actions-series {display: block; padding: 0; border: 0; color: var(--app-muted); background: transparent; font: inherit; text-align: left; line-height: 1.5; cursor: pointer;}
.book-actions-author {font-size: 14px;}
.book-actions-series {font-size: 12px; margin-top: 6px;}
.book-actions-progress {color: var(--app-primary); font-size: 12px; margin-top: 10px;}
.book-actions-primary {display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 22px;}
.book-actions-primary .q-btn, .book-actions-download {min-height: 42px; border-radius: 12px; padding: 10px 18px; font-size: 14px;}
.book-actions-download {display: flex; align-items: center; gap: 9px; text-decoration: none; color: var(--app-primary); border: 1px solid var(--app-border);}
.book-actions-formats {margin-top: 16px; max-width: 340px;}
.book-actions-secondary {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 16px; padding-top: 14px; margin-top: 18px; border-top: 1px solid var(--app-border);}
.book-actions-secondary button {display: flex; align-items: center; gap: 10px; padding: 12px 6px; text-align: left; color: var(--app-text); font: inherit; font-size: 13px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; line-height: 1.45;}
.book-actions-secondary button:hover {background: var(--app-surface-3);}
.book-actions-secondary button:disabled {opacity: .5; cursor: default;}
.book-actions-secondary .q-icon {font-size: 21px; color: var(--app-muted);}
.book-actions-unavailable {margin: 20px 0 0; color: var(--app-muted);}
button:focus-visible, a:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 3px;}
@media (max-width: 599px) {.book-actions-summary {gap: 16px;} .book-actions-summary > :deep(.book-cover) {width: 80px; flex-basis: 80px;} h2 {font-size: 19px;} .book-actions-primary {gap: 8px; margin-top: 18px;} .book-actions-primary .q-btn, .book-actions-download {padding: 10px 14px; font-size: 13px;} .book-actions-secondary {gap: 2px 8px;}}
</style>
