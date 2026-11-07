<template>
    <DialogSurface v-model="dialogVisible" variant="book" :embedded="embedded">
        <template #header>Книга в библиотеке</template>
        <div class="library-book-actions">
            <a ref="download" style="display: none" />
            <LoadingMessage :message="loadingMessage2" />
            <div class="book-actions-summary">
                <BookCover :book="book" />
                <div>
                    <div v-if="sizeLabel || dateLabel" class="book-actions-meta"><span v-if="sizeLabel">{{ sizeLabel }}</span><span v-if="dateLabel">Добавлена {{ dateLabel }}</span></div>
                    <component :is="embedded ? 'h1' : 'h2'">{{ book.title || 'Без названия' }}</component>
                    <span v-if="book.author" class="book-actions-author"><template v-for="(author,index) in authorLinks" :key="index"><span v-if="index">,</span><RouterLink :to="author.target" @click="dialogVisible = false">{{ author.label }}</RouterLink></template></span>
                    <RouterLink v-if="book.series" class="book-actions-series" :to="seriesTarget" @click="dialogVisible = false">{{ book.series }}<span v-if="book.serno"> · {{ book.serno }}</span></RouterLink>
                    <dl v-if="genreLabels.length || publicationYear || keywordLabels.length" class="book-actions-details">
                        <div v-if="genreLabels.length"><dt>Жанр</dt><dd>{{ genreLabels.join(', ') }}</dd></div>
                        <div v-if="publicationYear"><dt>Год</dt><dd>{{ publicationYear }}</dd></div>
                        <div v-if="keywordLabels.length"><dt>Ключевые слова</dt><dd>{{ keywordLabels.join(', ') }}</dd></div>
                    </dl>
                    <div v-if="percent !== null" class="book-actions-progress">{{ Math.round(percent * 100) }}% прочитано</div>
                </div>
            </div>
            <template v-if="!book.discoveryMissingLocal && !book.unavailable">
                <div class="book-actions-primary">
                    <q-btn v-if="canRead" color="primary" unelevated no-caps icon="la la-book-open" :label="readLabel" @click="bookEvent({action: 'readBook', book})" />
                    <a :href="getDirectBookDownloadHref(book, downloadFormat)" class="book-actions-download"><q-icon name="la la-download" size="20px" /> Скачать {{ downloadFormat === 'raw' ? sourceFormat : downloadFormat.toUpperCase() }}</a>
                </div>
                <q-select v-if="downloadFormats.length > 1" v-model="downloadFormat" outlined dense emit-value map-options :options="downloadFormats" label="Формат скачивания" class="book-actions-formats" />
                <section v-if="!embedded" class="book-actions-annotation" :aria-busy="annotationLoading" aria-label="Аннотация книги">
                    <h3>Аннотация</h3>
                    <LoadingState v-if="annotationLoading" label="Загружаем аннотацию" />
                    <div v-else-if="annotationStatus === 'unavailable'" class="book-actions-annotation-status" role="status">Не удалось загрузить аннотацию. <q-btn flat dense no-caps label="Повторить" @click="retryAnnotation" /></div>
                    <template v-else>
                        <p v-if="annotationText" class="book-actions-annotation-text">{{ annotationText }}</p>
                        <p v-if="annotationLimited || annotationStatus === 'limited'" class="book-actions-annotation-status">{{ annotationText ? 'Показан фрагмент аннотации.' : 'Аннотация не вошла в ограниченное превью.' }} Полное описание доступно в карточке книги.</p>
                        <p v-else-if="annotationStatus === 'unsupported'" class="book-actions-annotation-status">Для этого формата или источника аннотация в превью пока недоступна.</p>
                        <p v-else-if="annotationStatus === 'empty'" class="book-actions-annotation-status">В книге нет аннотации.</p>
                    </template>
                </section>
                <RouterLink v-if="!embedded && fullCardTarget" :to="fullCardTarget" class="book-actions-card-link" @click="dialogVisible = false"><q-icon name="la la-external-link-alt" size="18px" /> Полная карточка</RouterLink>
                <div class="book-actions-secondary">
                    <button v-if="!embedded" type="button" @click="$emit('details', book); dialogVisible = false"><q-icon name="la la-info-circle" /><span>Описание и сведения</span></button>
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
    </DialogSurface>
</template>

<script>
import vueComponent from '../vueComponent';
import BaseList from '../Search/BaseList';
import BookCover from './BookCover.vue';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DialogSurface from '../share/DialogSurface.vue';
import LoadingState from '../share/LoadingState.vue';
import {readable, progress} from './libraryModel';
import {catalogTarget, effectiveCatalogScope} from './catalogSearchModel';
const bookFormats = require('../../../shared/BookFormats');
const previewMetadata = require('../../../shared/BookPreview');

// Use the same download, format, email, Telegram and read-state actions as the catalog.
// This adapter has no search lifecycle or parallel implementation of those operations.
class BookActionsDialog extends BaseList {
    _props = {modelValue: Boolean, book: Object, genreMap: Object, embedded: Boolean};
    _options = {
        components: {DialogSurface, BookCover, LoadingMessage, LoadingState},
        emits: ['update:modelValue', 'listEvent', 'navigate', 'details', 'updated'],
        watch: {
            modelValue(value) {this.dialogVisible = value;},
            dialogVisible(value) {this.$emit('update:modelValue', value);if(value)this.loadAnnotation();else this.invalidateAnnotation();},
            annotationIdentity() {this.invalidateAnnotation();this.readOverride=null;
                this.downloadFormat=bookFormats.resolve(this.book.ext,this.config,bookFormats.profilePreference(this.config)) || 'raw';this.loadAnnotation();},
            settings() {this.loadSettings();},
        },
    };
    dialogVisible = false;
    list = {liberamaReady: false};
    downloadFormat = 'raw';
    readOverride = null;
    updatingRead = false;
    actionBusy = false;
    annotationText = '';
    annotationStatus = '';
    annotationLimited = false;
    annotationLoading = false;
    annotationLoaded = false;
    annotationGeneration = 0;
    annotationActive = true;
    annotationController = null;
    previewDetails = {};

    created() {
        super.created();
        this.dialogVisible = this.modelValue;
        this.downloadFormat = bookFormats.resolve(this.book.ext, this.config, bookFormats.profilePreference(this.config)) || 'raw';
        this.loadAnnotation();
    }
    beforeUnmount() {this.annotationActive=false;this.invalidateAnnotation();super.beforeUnmount();}
    deactivated() {this.annotationActive=false;this.invalidateAnnotation();}
    activated() {this.annotationActive=true;this.loadAnnotation();}
    refresh() {}

    get previewScope() {return effectiveCatalogScope(this.$route?.query || {},this.settings,this.config);}
    get authorLinks() {return String(this.book.author || '').split(',').filter(label=>label.trim()).map(label=>({label,
        target:catalogTarget('/author-details',{name:label.trim()},this.previewScope)}));}
    get seriesTarget() {return catalogTarget('/series-details',{name:this.book.series},this.previewScope);}
    get genreLabels(){return previewMetadata.tokens(this.book.genre||this.previewDetails.genres).map(code=>this.genreMap instanceof Map?this.genreMap.get(code)||code:this.genreMap?.[code]||code);}
    get publicationYear(){return previewMetadata.year(this.previewDetails.publishedYear)||previewMetadata.year(this.book.publishedYear)||previewMetadata.year(this.book.year);}
    get keywordLabels(){return previewMetadata.tokens(this.book.keywords||this.previewDetails.keywords);}
    get annotationIdentity() {return JSON.stringify([this.getBookUid(this.book),this.book._recordHash || '',this.book.sourceId || '',
        this.config.dbConfig?.inpxHash || '',this.config.rootPathStatic || '',this.config.currentUserId || '',
        this.config.currentUserProfile?.id || '',!!this.config.profileAuthorized,this.settings.currentUserId || '']);}
    invalidateAnnotation() {
        this.annotationGeneration++;this.annotationController?.abort();this.annotationController=null;
        this.annotationText='';this.annotationStatus='';this.annotationLimited=false;this.annotationLoading=false;this.annotationLoaded=false;
        this.previewDetails={};
    }
    annotationCurrent(generation,identity) {return this.annotationActive && this.dialogVisible && generation===this.annotationGeneration && identity===this.annotationIdentity;}
    async loadAnnotation() {
        if(!this.annotationActive || !this.dialogVisible || this.embedded || this.annotationLoading || this.annotationLoaded
            || !this.getBookUid(this.book) || this.book.discoveryMissingLocal || this.book.unavailable)return;
        const generation=this.annotationGeneration,identity=this.annotationIdentity,uid=this.getBookUid(this.book),controller=new AbortController();
        this.annotationController=controller;this.annotationLoading=true;this.annotationStatus='';
        try {
            const response=await this.api.getBookPreview(uid,{signal:controller.signal});
            if(!this.annotationCurrent(generation,identity))return;
            const preview=response?.bookPreview;
            if(!preview || preview.bookUid!==uid)throw new Error('Unexpected preview response');
            this.previewDetails={publishedYear:previewMetadata.year(preview.publishedYear),genres:previewMetadata.tokens(preview.genres),keywords:previewMetadata.tokens(preview.keywords)};
            this.annotationText=typeof preview.annotation==='string' ? preview.annotation.slice(0,6000):'';
            this.annotationStatus=['ready','empty','limited','unsupported','unavailable'].includes(preview.annotationStatus) ? preview.annotationStatus:'unavailable';
            this.annotationLimited=preview.annotationLimited===true;
            this.annotationLoaded=this.annotationStatus!=='unavailable';
            if(this.annotationStatus==='ready' && !this.annotationText)this.annotationStatus='empty';
        } catch (_) {if(this.annotationCurrent(generation,identity))this.annotationStatus='unavailable';}
        finally {if(this.annotationCurrent(generation,identity)){this.annotationLoading=false;this.annotationController=null;}}
    }
    retryAnnotation() {this.invalidateAnnotation();return this.loadAnnotation();}

    get sourceFormat() {return String(this.book.ext || 'Книга').toUpperCase();}
    get fullCardTarget() {
        const uid = this.getBookUid(this.book);
        return uid && !this.book.discoveryMissingLocal ? catalogTarget('/book', {bookUid: uid}, this.previewScope) : null;
    }
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
.book-actions-author, .book-actions-series {display: block; padding: 0; border: 0; font: inherit; text-align: left; line-height: 1.5; overflow-wrap: anywhere;}
.book-actions-author {font-size: 14px; width: fit-content; max-width: 100%;}
.book-actions-author a, .book-actions-series {color: var(--app-link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px;}
.book-actions-author a:hover, .book-actions-series:hover {color: var(--app-primary);}
.book-actions-series {font-size: 12px; margin-top: 6px;}
.book-actions-details {display: grid; gap: 6px; margin: 12px 0 0; font-size: 12px; line-height: 1.55;}
.book-actions-details dt {display: inline; color: var(--app-muted);}
.book-actions-details dd {display: inline; margin: 0 0 0 8px; overflow-wrap: anywhere;}
.book-actions-progress {color: var(--app-primary); font-size: 12px; margin-top: 10px;}
.book-actions-primary {display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 22px;}
.book-actions-primary .q-btn, .book-actions-download {min-height: 42px; border-radius: 12px; padding: 10px 18px; font-size: 14px;}
.book-actions-download {display: flex; align-items: center; gap: 9px; text-decoration: none; color: var(--app-primary); border: 1px solid var(--app-border);}
.book-actions-formats {margin-top: 16px; max-width: 340px;}
.book-actions-card-link {display: inline-flex; align-items: center; gap: 7px; margin-top: 16px; padding: 5px 0; color: var(--app-link); font-size: 13px; text-decoration: none; border-radius: 6px;}
.book-actions-card-link:hover {text-decoration: underline;}
.book-actions-secondary {display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 16px; padding-top: 14px; margin-top: 18px; border-top: 1px solid var(--app-border);}
.book-actions-secondary button {display: flex; align-items: center; gap: 10px; padding: 12px 6px; text-align: left; color: var(--app-text); font: inherit; font-size: 13px; border: 0; border-radius: 10px; background: transparent; cursor: pointer; line-height: 1.45;}
.book-actions-secondary button:hover {background: var(--app-surface-3);}
.book-actions-secondary button:disabled {opacity: .5; cursor: default;}
.book-actions-secondary .q-icon {font-size: 21px; color: var(--app-muted);}
.book-actions-unavailable {margin: 20px 0 0; color: var(--app-muted);}
.book-actions-annotation {margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--app-border);}
.book-actions-annotation h3 {font-size: 14px; font-weight: 600; margin: 0 0 10px;}
.book-actions-annotation-text {white-space: pre-line; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; margin: 0;}
.book-actions-annotation-status {font-size: 13px; line-height: 1.5; color: var(--app-muted); margin: 0;}
button:focus-visible, a:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 3px;}
@media (max-width: 599px) {.book-actions-summary {gap: 16px;} .book-actions-summary > :deep(.book-cover) {width: 80px; flex-basis: 80px;} h2 {font-size: 19px;} .book-actions-primary {gap: 8px; margin-top: 18px;} .book-actions-primary .q-btn, .book-actions-download {padding: 10px 14px; font-size: 13px;} .book-actions-secondary {gap: 2px 8px;}}
</style>
