<template>
    <article class="book-tile" :class="{'book-tile--actions': quickActions}">
        <button type="button" class="book-tile__open" :aria-label="`Открыть карточку: ${book.title}`" @click="library.openCard(book)">
            <BookCover :book="book" />
            <span class="book-tile__title">{{ book.title || 'Без названия' }}</span>
            <span class="book-tile__author">{{ book.author || 'Автор не указан' }}</span>
            <span v-if="percent !== null" class="book-tile__progress">{{ Math.round(percent * 100) }}% прочитано</span>
            <span v-else class="book-tile__format">{{ book.discoveryMissingLocal ? 'Внешняя подборка' : (book.ext || '').toUpperCase() }}</span>
        </button>
        <div v-if="quickActions" class="book-tile__toolbar" role="group" :aria-label="'Действия с книгой: ' + book.title">
            <BookSendButton v-if="available" :book="book" :config="config" compact />
            <q-btn v-if="canRead || (available && config.bookReadLink)" flat dense icon="la la-book-open"
                aria-label="Читать" title="Читать" :loading="opening" @click="read" />
            <BookQuickMenu :book="book" :history-generation="historyGeneration" compact>
                <q-item v-close-popup clickable role="menuitem" @click="library.openCard(book)">
                    <q-item-section avatar><q-icon name="la la-info-circle" /></q-item-section><q-item-section>Открыть карточку</q-item-section>
                </q-item>
                <q-item v-if="available" v-close-popup clickable role="menuitem" @click="library.openLists(book)">
                    <q-item-section avatar><q-icon name="la la-bookmark" /></q-item-section><q-item-section>Добавить на полку</q-item-section>
                </q-item>
            </BookQuickMenu>
        </div>
        <button v-else type="button" class="book-tile__details" :aria-label="`Действия с книгой: ${book.title}`" @click="library.openActions(book)">
            <q-icon name="la la-ellipsis-v" size="19px" aria-hidden="true" />
        </button>
    </article>
</template>

<script setup>
import {computed, getCurrentInstance, inject, ref} from 'vue';
import escape from 'lodash/escape';
import BookCover from './BookCover.vue';
import BookSendButton from './BookSendButton.vue';
import BookQuickMenu from './BookQuickMenu.vue';
import {openExternalReader} from './bookFileActions';
import {libraryContextKey} from './libraryContext';
import {bookUid, progress, readable} from './libraryModel';

const props = defineProps({book: {type: Object, required: true}, quickActions:Boolean, historyGeneration:Number});
const library = inject(libraryContextKey);
const {config} = library;
const root = getCurrentInstance().proxy.$root;
const percent = computed(() => progress(props.book));
const available = computed(() => !!bookUid(props.book) && !props.book.unavailable && !props.book.discoveryMissingLocal);
const canRead = computed(() => readable(props.book, config.value));
const opening = ref(false);
async function read() {
    if (canRead.value) return library.openBook(props.book);
    if (opening.value) return;
    opening.value = true;
    try {
        const template = config.value.bookReadLink;
        const {link} = await library.api.getBookLink(bookUid(props.book));
        openExternalReader(template, new URL(link, window.location.origin).href);
    } catch (error) {root.stdDialog.alert(escape(error.message), 'Не удалось открыть книгу');}
    finally {opening.value = false;}
}
</script>

<style scoped>
.book-tile {position: relative; min-width: 0;}
.book-tile__open {width: 100%; display: block; border: 0; padding: 0; text-align: left; font: inherit; color: inherit; background: transparent; cursor: pointer; border-radius: 10px;}
.book-tile__title {display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.4; font-size: 14px; font-weight: 550; margin: 10px 15px 3px 0; min-height: 2.8em; overflow-wrap: anywhere;}
.book-tile__author {display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--app-muted);}
.book-tile__progress, .book-tile__format {display: block; font-size: 12px; color: var(--app-primary); margin-top: 3px;}
.book-tile__format {color: var(--app-muted);}
.book-tile--actions .book-tile__title {margin-right: 0;}
.book-tile__toolbar {display: flex; align-items: center; margin-top: 6px; gap: 2px; color: var(--app-muted);}
.book-tile__toolbar :deep(.q-btn) {flex: 0 1 36px; min-width: 0; min-height: 36px; padding: 0; border-radius: 8px;}
.book-tile__toolbar :deep(.q-icon), .book-tile__toolbar :deep(.book-action-icon) {width: 20px; height: 20px; font-size: 20px;}
.book-tile__details {position: absolute; right: -7px; bottom: 49px; display: grid; place-items: center; width: 30px; height: 34px; border: 0; border-radius: 8px; color: var(--app-muted); background: var(--app-bg); cursor: pointer;}
button:focus-visible {outline: 3px solid var(--app-primary); outline-offset: 4px;}
@media (hover: hover) {.book-tile__open:hover :deep(.book-cover) {box-shadow: 0 6px 18px #00000025;} .book-tile__open:hover .book-tile__title {color: var(--app-primary);}}
</style>
