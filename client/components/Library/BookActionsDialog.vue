<template>
    <DialogSurface v-model="dialogVisible" variant="book" :embedded="embedded">
        <template #header><h2 class="book-actions-title">{{ book.title || 'Без названия' }}</h2></template>
        <div class="library-book-actions">
            <a ref="download" style="display: none" />
            <LoadingMessage :message="loadingMessage2" />
            <h1 v-if="embedded" class="book-actions-title">{{ book.title || 'Без названия' }}</h1>
            <div class="book-actions-summary">
                <BookCover :book="book" />
                <div>
                    <span v-if="book.author" class="book-actions-author"><template v-for="(author,index) in authorLinks" :key="index"><span v-if="index">, </span><RouterLink :to="author.target" @click="dialogVisible = false">{{ author.label }}</RouterLink></template></span>
                    <p class="book-actions-meta">{{ sourceFormat }}<template v-if="languageLabel"> · {{ languageLabel }}</template></p>
                    <p class="book-actions-availability">{{ book.discoveryMissingLocal ? 'Внешний источник' : book.unavailable ? 'Книга недоступна' : 'В библиотеке' }}</p>
                    <p v-if="publicationYear" class="book-actions-year">Год: <span>{{ publicationYear }}</span></p>
                    <div v-if="percent !== null" class="book-actions-progress">{{ Math.round(percent * 100) }}% прочитано</div>
                </div>
            </div>
            <div class="book-actions-content">
                <div v-if="bookAvailable" class="book-actions-primary">
                    <q-select v-model="downloadFormat" outlined dense emit-value map-options :options="downloadFormats" :display-value="downloadLabel" aria-label="Формат скачивания" class="book-actions-formats" />
                    <q-btn v-if="canSend" outline aria-label="Отправить книгу" title="Отправить книгу" aria-haspopup="menu" :aria-expanded="sendMenuOpen" :disable="actionBusy">
                        <BookActionIcon name="send" />
                        <q-menu v-model="sendMenuOpen" class="book-actions-menu" anchor="bottom right" self="top right">
                            <q-list role="menu" aria-label="Отправить книгу">
                                <q-item v-if="config.telegramShareEnabled" v-close-popup clickable role="menuitem" @click="perform('sendTelegram')"><q-item-section avatar><q-icon name="lab la-telegram-plane" /></q-item-section><q-item-section>Отправить в Telegram</q-item-section></q-item>
                                <q-item v-if="config.emailShareEnabled" v-close-popup clickable role="menuitem" @click="perform('sendEmail')"><q-item-section avatar><q-icon name="la la-envelope" /></q-item-section><q-item-section>Отправить по Email</q-item-section></q-item>
                            </q-list>
                        </q-menu>
                    </q-btn>
                    <q-btn outline aria-label="Полки и статус" title="Полки и статус" aria-haspopup="menu" :aria-expanded="libraryMenuOpen">
                        <BookActionIcon name="shelf" />
                        <q-menu v-model="libraryMenuOpen" class="book-actions-menu" anchor="bottom right" self="top right">
                            <q-list role="menu" aria-label="Полки и статус">
                                <q-item v-close-popup clickable role="menuitem" @click="bookEvent({action: 'readingList', book})"><q-item-section avatar><BookActionIcon name="shelf" /></q-item-section><q-item-section>Добавить на полку</q-item-section></q-item>
                                <q-item v-if="config.profileAuthorized" v-close-popup clickable role="menuitem" :disable="updatingRead" @click="toggleRead"><q-item-section avatar><q-icon :name="markedRead ? 'la la-undo' : 'la la-check-circle'" /></q-item-section><q-item-section>{{ markedRead ? 'Снять отметку' : 'Прочитано' }}</q-item-section></q-item>
                            </q-list>
                        </q-menu>
                    </q-btn>
                    <q-btn v-if="canRead" outline no-caps icon="la la-book-open" :aria-label="readLabel" :title="readLabel" @click="bookEvent({action: 'readBook', book})" />
                    <q-btn outline aria-label="Поделиться книгой" title="Поделиться книгой" aria-haspopup="menu" :aria-expanded="shareMenuOpen" :disable="actionBusy">
                        <BookActionIcon name="share" />
                        <q-menu v-model="shareMenuOpen" class="book-actions-menu" anchor="bottom right" self="top right">
                            <q-list role="menu" aria-label="Поделиться книгой">
                                <q-item v-if="nativeShareSupported" v-close-popup clickable role="menuitem" @click="shareBook"><q-item-section avatar><BookActionIcon name="share" /></q-item-section><q-item-section>Поделиться…</q-item-section></q-item>
                                <q-item v-close-popup clickable role="menuitem" @click="perform('copyLink')"><q-item-section avatar><q-icon name="la la-link" /></q-item-section><q-item-section>Копировать ссылку</q-item-section></q-item>
                                <q-item v-if="!embedded && fullCardTarget" v-close-popup clickable role="menuitem" :to="fullCardTarget" @click="dialogVisible = false"><q-item-section avatar><q-icon name="la la-external-link-alt" /></q-item-section><q-item-section>Открыть страницу книги</q-item-section></q-item>
                            </q-list>
                        </q-menu>
                    </q-btn>
                </div>
                <dl v-if="genreLabels.length" class="book-actions-details book-actions-genres"><div><dt>Жанр</dt><dd>{{ genreLabels.join(', ') }}</dd></div></dl>
                <a v-if="bookAvailable" :href="getDirectBookDownloadHref(book, downloadFormat)" class="book-actions-download" :aria-label="'Скачать ' + downloadLabel"><span>Скачать книгу</span><span>{{ downloadLabel }}</span></a>
                <button v-if="!embedded && bookAvailable" type="button" class="book-actions-full-description" @click="$emit('details', book); dialogVisible = false">Полное описание</button>
                <a v-if="lightReaderUrl" :href="lightReaderUrl" class="book-actions-reader">Лёгкая читалка</a>
                <RouterLink v-if="book.series" class="book-actions-series" :to="seriesTarget" @click="dialogVisible = false">Серия: {{ book.series }}<span v-if="book.serno"> · Том {{ book.serno }}</span></RouterLink>
                <dl v-if="keywordLabels.length" class="book-actions-details book-actions-keywords"><div><dt>Ключевые слова</dt><dd>{{ keywordLabels.join(', ') }}</dd></div></dl>
                <p v-if="sizeLabel || dateLabel" class="book-actions-file"><span v-if="sizeLabel">Файл · {{ sizeLabel }}</span><span v-if="dateLabel">Добавлена {{ dateLabel }}</span></p>
                <section v-if="!embedded && bookAvailable" class="book-actions-annotation" :aria-busy="annotationLoading" aria-label="Аннотация книги">
                    <h3>Аннотация</h3>
                    <LoadingState v-if="annotationLoading" label="Загружаем аннотацию" />
                    <div v-else-if="annotationStatus === 'unavailable'" class="book-actions-annotation-status" role="status">Не удалось загрузить аннотацию. <q-btn flat dense no-caps label="Повторить" @click="retryAnnotation" /></div>
                    <template v-else>
                        <p v-for="(paragraph,index) in annotationParagraphs" :key="index" class="book-actions-annotation-text">{{ paragraph }}</p>
                        <p v-if="annotationLimited || annotationStatus === 'limited'" class="book-actions-annotation-status">{{ annotationText ? 'Показан фрагмент аннотации.' : 'Аннотация не вошла в ограниченное превью.' }} Полное описание доступно в карточке книги.</p>
                        <p v-else-if="annotationStatus === 'unsupported'" class="book-actions-annotation-status">Для этого формата или источника аннотация в превью пока недоступна.</p>
                        <p v-else-if="annotationStatus === 'empty'" class="book-actions-annotation-status">В книге нет аннотации.</p>
                    </template>
                </section>
            </div>
            <q-btn v-if="!bookAvailable && externalUrl" color="primary" no-caps unelevated label="Открыть источник" icon="la la-external-link-alt" :href="externalUrl" target="_blank" rel="noopener noreferrer" />
            <p v-else-if="!bookAvailable" class="book-actions-unavailable">Книга сейчас недоступна в каталоге.</p>
        </div>
    </DialogSurface>
</template>

<script>
import vueComponent from '../vueComponent';
import BaseList from '../Search/BaseList';
import BookCover from './BookCover.vue';
import BookActionIcon from './BookActionIcon.vue';
import LoadingMessage from '../Search/LoadingMessage/LoadingMessage.vue';
import DialogSurface from '../share/DialogSurface.vue';
import LoadingState from '../share/LoadingState.vue';
import {QMenu, QList, QItem, QItemSection} from 'quasar';
import {readable, ebookReaderUrl, progress} from './libraryModel';
import {catalogTarget, effectiveCatalogScope} from './catalogSearchModel';
const bookFormats = require('../../../shared/BookFormats');
const previewMetadata = require('../../../shared/BookPreview');

// Use the same download, format, email, Telegram and read-state actions as the catalog.
// This adapter has no search lifecycle or parallel implementation of those operations.
class BookActionsDialog extends BaseList {
    _props = {modelValue: Boolean, book: Object, genreMap: Object, embedded: Boolean};
    _options = {
        components: {DialogSurface, BookCover, BookActionIcon, LoadingMessage, LoadingState, QMenu, QList, QItem, QItemSection},
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
    sendMenuOpen = false;
    libraryMenuOpen = false;
    shareMenuOpen = false;
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
        this.libraryMenuOpen=false;this.shareMenuOpen=false;this.sendMenuOpen=false;
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
    get bookAvailable() {return !this.book.discoveryMissingLocal && !this.book.unavailable;}
    get canSend() {return !!(this.config.telegramShareEnabled || this.config.emailShareEnabled);}
    get nativeShareSupported() {return typeof navigator!=='undefined' && typeof navigator.share==='function';}
    get downloadLabel() {return this.downloadFormat === 'raw' ? this.sourceFormat : this.downloadFormat.toUpperCase();}
    get annotationParagraphs() {return this.annotationText.split(/\n\s*\n/).filter(text=>text.trim());}
    get languageLabel() {
        return String(this.book.lang || '').split(',').slice(0,4).map(value=>{
            const code=value.trim();if(!code)return '';
            try{return typeof Intl.DisplayNames==='function' ? new Intl.DisplayNames(['ru'],{type:'language'}).of(code):code;}catch{return code;}
        }).filter(Boolean).join(', ');
    }
    get fullCardTarget() {
        const uid = this.getBookUid(this.book);
        return uid && !this.book.discoveryMissingLocal ? catalogTarget('/book', {bookUid: uid}, this.previewScope) : null;
    }
    get percent() {return progress(this.book);}
    get markedRead() {return this.readOverride ?? (this.book.state === 'read' || this.book._readingListRead === true || this.book.read === true || this.percent >= .999);}
    get canRead() {return readable(this.book, this.config) || (!this.book.unavailable && !!String(this.config.bookReadLink || '').trim());}
    get lightReaderUrl() {return ebookReaderUrl(this.book, this.config);}
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
    async shareBook() {
        if(this.actionBusy)return;
        if(this.nativeShareSupported && this.fullCardTarget){
            this.actionBusy=true;
            try{await navigator.share({title:this.book.title,url:new URL(this.$router.resolve(this.fullCardTarget).href,window.location.href).href});return;}
            catch(error){if(error.name==='AbortError')return;}
            finally{this.actionBusy=false;}
        }
        await this.perform('copyLink');
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
.book-actions-unavailable {margin: 20px 0 0; color: var(--app-muted);}
.book-actions-annotation {margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--app-border);}
.book-actions-annotation h3 {font-size: 14px; font-weight: 600; margin: 0 0 10px;}
.book-actions-annotation-text {white-space: pre-line; overflow-wrap: anywhere; font-size: 14px; line-height: 1.65; margin: 0;}
.book-actions-annotation-status {font-size: 13px; line-height: 1.5; color: var(--app-muted); margin: 0;}
button:focus-visible, a:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 3px;}
.book-actions-title {font-size: 23px; font-weight: 550; line-height: 1.35; margin: 0; overflow-wrap: anywhere;}
h1.book-actions-title {margin-bottom: 20px;}
.book-actions-summary {gap: 20px; padding-top: 4px;}
.book-actions-summary > :deep(.book-cover) {width: 112px; flex-basis: 112px;}
.book-actions-summary > div:not(.book-cover) {padding-top: 10px;}
.book-actions-author {font-size: 15px;}
.book-actions-meta {margin: 14px 0 2px; font-size: 13px;}
.book-actions-availability {margin: 0; color: var(--app-primary); font-size: 13px;}
.book-actions-year {margin: 2px 0 0; color: var(--app-muted); font-size: 13px;}
.book-actions-primary {justify-content: flex-end; gap: 8px; margin: 18px 0;}
.book-actions-primary .q-btn {width: 44px; flex: 0 0 44px; min-height: 44px; padding: 0; border-radius: 12px; color: var(--app-text);}
.book-actions-primary .q-btn :deep(.q-icon) {font-size: 23px;}
.book-actions-formats {margin: 0; width: 110px; min-width: 0;}
.book-actions-formats :deep(.q-field__control) {min-height: 44px; border-radius: 12px;}
.book-actions-details {font-size: 14px; line-height: 1.55; margin: 18px 0;}
.book-actions-genres dt {color: var(--app-text);}
.book-actions-genres dt::after {content: ':';}
.book-actions-genres dd {margin-left: 5px;}
.book-actions-download {width: 100%; justify-content: center; min-height: 46px; padding: 11px 16px; background: var(--app-primary, var(--q-primary, #00796f)); color: var(--library-on-primary, #fff); border: 0; border-radius: 13px; font-size: 15px; font-weight: 550;}
.book-actions-download span:last-child {font-size: 12px; font-weight: 500; opacity: .85;}
.book-actions-full-description {width: 100%; min-height: 44px; margin-top: 14px; padding: 10px 16px; border: 1px solid var(--app-muted); border-radius: 13px; color: var(--app-link); background: transparent; font: inherit; font-size: 14px; cursor: pointer;}
.book-actions-reader {display: inline-block; padding: 8px 0; color: var(--app-link); font-size: 14px;}
.book-actions-series {font-size: 14px; margin-top: 26px; margin-bottom: 24px; text-decoration: none;}
.book-actions-series:hover {text-decoration: underline;}
.book-actions-keywords dt {display: block; color: var(--app-muted); font-size: 12px; margin-bottom: 5px;}
.book-actions-keywords dd {margin: 0; display: block; line-height: 1.55;}
.book-actions-file {display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--app-muted); font-size: 12px; margin: 14px 0 22px;}
.book-actions-annotation {margin-top: 24px; padding: 0; border: 0;}
.book-actions-annotation h3 {font-size: 19px; font-weight: 500; margin: 0 0 12px;}
.book-actions-annotation-text {font-family: Georgia, 'Times New Roman', serif; font-size: 18px; line-height: 1.65; white-space: pre-line; margin: 0 0 18px;}
:global(.q-menu.book-actions-menu) {max-width: calc(100vw - 24px); min-width: 210px; background: var(--app-surface, #fff); color: var(--app-text, #183236); border: 1px solid var(--app-border, #d6e3e3); border-radius: 12px; padding: 4px;}
:global(body.body--dark .q-menu.book-actions-menu) {background: var(--app-surface, #192a32); color: var(--app-text, #e3eff0);}
:global(.book-actions-menu .q-item) {min-height: 44px; border-radius: 8px; padding: 8px 10px; font-size: 14px;}
:global(.book-actions-menu .q-item__section--avatar) {min-width: 30px; color: var(--app-muted, #52696d);}
@media (max-width: 599px) {
    .book-actions-title {font-size: 21px;}
    .book-actions-summary {gap: 16px;}
    .book-actions-summary > :deep(.book-cover) {width: 88px; flex-basis: 88px;}
    .book-actions-summary > div:not(.book-cover) {padding-top: 4px;}
    .book-actions-author {font-size: 14px;}
    .book-actions-primary {gap: 8px; margin: 16px 0;}
    .book-actions-primary .q-btn {width: 44px; min-height: 44px;}
    .book-actions-formats {width: 96px;}
    .book-actions-formats :deep(.q-field__control) {padding: 0 8px;}
    .book-actions-series {margin: 10px 0 12px;}
    .book-actions-annotation {margin-top: 12px;}
    .book-actions-annotation h3 {margin-bottom: 8px;}
}
@media (max-width: 379px) {
    .book-actions-formats {flex-basis: 100%; width: 100%; max-width: none;}
}
</style>
