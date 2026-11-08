<template>
    <article class="book-tile">
        <button type="button" class="book-tile__open" :aria-label="`Открыть карточку: ${book.title}`" @click="library.openCard(book)">
            <BookCover :book="book" />
            <span class="book-tile__title">{{ book.title || 'Без названия' }}</span>
            <span class="book-tile__author">{{ book.author || 'Автор не указан' }}</span>
            <span v-if="percent !== null" class="book-tile__progress">{{ Math.round(percent * 100) }}% прочитано</span>
            <span v-else class="book-tile__format">{{ book.discoveryMissingLocal ? 'Внешняя подборка' : (book.ext || '').toUpperCase() }}</span>
        </button>
        <button type="button" class="book-tile__details" :aria-label="`Действия с книгой: ${book.title}`" @click="library.openActions(book)">
            <q-icon name="la la-ellipsis-v" size="19px" aria-hidden="true" />
        </button>
    </article>
</template>

<script setup>
import {computed, inject} from 'vue';
import BookCover from './BookCover.vue';
import {libraryContextKey} from './libraryContext';
import {progress} from './libraryModel';

const props = defineProps({book: {type: Object, required: true}});
const library = inject(libraryContextKey);
const percent = computed(() => progress(props.book));
</script>

<style scoped>
.book-tile {position: relative; min-width: 0;}
.book-tile__open {width: 100%; display: block; border: 0; padding: 0; text-align: left; font: inherit; color: inherit; background: transparent; cursor: pointer; border-radius: 10px;}
.book-tile__title {display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; line-height: 1.4; font-size: 14px; font-weight: 550; margin: 10px 15px 3px 0; min-height: 2.8em; overflow-wrap: anywhere;}
.book-tile__author {display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; color: var(--app-muted);}
.book-tile__progress, .book-tile__format {display: block; font-size: 12px; color: var(--app-primary); margin-top: 3px;}
.book-tile__format {color: var(--app-muted);}
.book-tile__details {position: absolute; right: -7px; bottom: 49px; display: grid; place-items: center; width: 30px; height: 34px; border: 0; border-radius: 8px; color: var(--app-muted); background: var(--app-bg); cursor: pointer;}
button:focus-visible {outline: 3px solid var(--app-primary); outline-offset: 4px;}
@media (hover: hover) {.book-tile__open:hover :deep(.book-cover) {box-shadow: 0 6px 18px #00000025;} .book-tile__open:hover .book-tile__title {color: var(--app-primary);}}
</style>
