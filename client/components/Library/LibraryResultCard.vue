<template>
    <article class="library-result-card" :class="{'library-result-card--compact': compact}">
        <div class="library-result-card__cover">
            <button type="button" :aria-label="`Открыть карточку: ${book.title}`" @click="library.openCard(book)"><BookCover :book="book" /></button>
            <q-checkbox v-if="selectable" :model-value="selected" dense class="library-result-card__select" :aria-label="`Выбрать: ${book.title}`" @update:model-value="$emit('selection', $event)" />
        </div>
        <div class="library-result-card__body">
            <div class="library-result-card__top"><span>{{ (book.ext || 'КНИГА').toUpperCase() }}<span v-if="showRates && book.librate"> · ★ {{ book.librate }}/5</span></span><button type="button" :aria-label="`Действия с книгой: ${book.title}`" @click="library.openActions(book)"><q-icon name="la la-ellipsis-v" size="22px" /></button></div>
            <button type="button" class="library-result-card__title" @click="library.openCard(book)">{{ book.title || 'Без названия' }}</button>
            <button v-if="book.author" type="button" class="library-result-card__author" @click="$emit('action', 'authorClick')">{{ book.author }}</button>
            <button v-if="book.series" type="button" class="library-result-card__series" @click="$emit('action', 'seriesClick')">{{ book.series }}<span v-if="book.serno"> · {{ book.serno }}</span></button>
            <div v-if="percent !== null" class="library-result-card__progress">{{ Math.round(percent * 100) }}% прочитано</div>
            <p v-if="reason" class="library-result-card__reason">{{ reason }}</p>
            <div v-if="!compact && (genres.length || dateLabel)" class="library-result-card__genres"><button v-for="genre in genres" :key="genre.value" type="button" @click="$emit('genre', genre.value)">{{ genre.label }}</button><span v-if="dateLabel">{{ dateLabel }}</span></div>
            <div class="library-result-card__actions">
                <q-btn v-if="canRead" unelevated no-caps color="primary" label="Читать" @click="$emit('action', 'readBook')" />
                <a v-if="!book.discoveryMissingLocal && !book.unavailable" :href="downloadHref" :aria-label="`Скачать: ${book.title}`"><q-icon name="la la-download" size="18px" /> Скачать</a>
                <button v-if="showInfo" type="button" aria-label="Информация о книге" @click="library.openCard(book)"><q-icon name="la la-info-circle" size="20px" /></button>
                <button v-if="authorized && !book.discoveryMissingLocal" type="button" aria-label="Добавить книгу на полку" @click="$emit('action', 'readingList')"><q-icon name="la la-bookmark" size="20px" /></button>
                <button v-if="restore" type="button" @click="$emit('restore')"><q-icon name="la la-undo" /> Вернуть</button>
            </div>
            <details v-if="feedback" class="library-result-card__feedback">
                <summary>Настроить рекомендации</summary>
                <div><button v-for="option in feedbackOptions" :key="option.value" type="button" @click="$emit('feedback', option.value)">{{ option.label }}</button></div>
            </details>
        </div>
    </article>
</template>

<script setup>
import {computed, inject} from 'vue';
import BookCover from './BookCover.vue';
import {libraryContextKey} from './libraryContext';
import {readable, progress} from './libraryModel';

const props = defineProps({book: {type: Object, required: true}, downloadHref: String, selectable: Boolean, selected: Boolean,
    showRates: Boolean, showInfo: Boolean, dateLabel: String, genres: {type: Array, default: () => []}, feedback: Boolean, restore: Boolean, reason: String, compact: Boolean});
defineEmits(['action', 'selection', 'genre', 'feedback', 'restore']);
const feedbackOptions = [{value: 'more_like_this', label: 'Больше похожего'}, {value: 'not_interested', label: 'Неинтересно'},
    {value: 'dislike_author', label: 'Меньше этого автора'}, {value: 'dislike_genre', label: 'Меньше этого жанра'},
    {value: 'already_read', label: 'Уже прочитано'}, {value: 'ignore_for_taste', label: 'Не учитывать во вкусах'}];
const library = inject(libraryContextKey);
const canRead = computed(() => readable(props.book, library.config.value));
const percent = computed(() => progress(props.book));
const authorized = computed(() => !!library.config.value.profileAuthorized);
</script>

<style scoped>
.library-result-card {display: flex; align-items: stretch; gap: 18px; padding: 20px; min-width: 0; border-radius: 18px; background: var(--app-surface); color: var(--app-text); margin: 8px 0;}
.library-result-card__cover {width: 86px; flex-shrink: 0; position: relative; padding-top: 3px;}
.library-result-card__cover > button {display: block; width: 100%; border: 0; padding: 0; background: transparent; border-radius: 9px; cursor: pointer;}
.library-result-card__select {position: absolute; top: 0; left: -8px; background: var(--app-surface); border-radius: 8px;}
.library-result-card__body {display: flex; flex-direction: column; flex: 1; min-width: 0;}
.library-result-card__top {display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--app-muted); font-size: 11px; margin: -3px 0 6px;}
.library-result-card__top > button {border: 0; background: transparent; color: var(--app-muted); padding: 3px; margin: -4px -6px -4px 0; border-radius: 6px; cursor: pointer;}
.library-result-card__title, .library-result-card__author, .library-result-card__series {display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; flex-shrink: 0; border: 0; padding: 0; color: inherit; font: inherit; text-align: left; background: transparent; cursor: pointer; overflow-wrap: anywhere;}
.library-result-card__title {-webkit-line-clamp: 2; max-height: 2.7em; font-size: 17px; line-height: 1.35; font-weight: 550; margin-bottom: 6px;}
.library-result-card__author {-webkit-line-clamp: 2; max-height: 3em; font-size: 13px; color: var(--app-muted); line-height: 1.5;}
.library-result-card__series {-webkit-line-clamp: 1; max-height: 1.5em; font-size: 12px; color: var(--app-muted); margin-top: 3px; line-height: 1.5;}
.library-result-card__progress {font-size: 11px; color: var(--app-primary); margin-top: 5px;}
.library-result-card__reason {font-size: 12px; line-height: 1.5; color: var(--app-muted); margin: 8px 0 0;}
.library-result-card__feedback {font-size: 12px; color: var(--app-muted); margin-top: 12px;}
.library-result-card__feedback summary {cursor: pointer; padding: 4px 0;}
.library-result-card__feedback > div {display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px;}
.library-result-card__feedback button {font: inherit; color: var(--app-text); border: 1px solid var(--app-border); border-radius: 8px; background: transparent; padding: 6px 9px; cursor: pointer;}
.library-result-card__genres {display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: var(--app-muted); font-size: 10px;}
.library-result-card__genres > button {font: inherit; color: inherit; padding: 3px 6px; background: var(--app-surface-3); border: 0; border-radius: 5px; cursor: pointer;}
.library-result-card__actions {display: flex; gap: 13px; align-items: center; flex-wrap: wrap; margin-top: auto; padding-top: 14px;}
.library-result-card__actions > .q-btn {border-radius: 10px; padding: 6px 16px; min-height: 34px; font-size: 12px; font-weight: 550;}
.library-result-card__actions > a, .library-result-card__actions > button {display: flex; align-items: center; gap: 5px; color: var(--app-muted); font: inherit; font-size: 12px; border: 0; border-radius: 6px; background: transparent; padding: 5px 0; text-decoration: none; cursor: pointer;}
.library-result-card.library-result-card--compact {padding: 12px; gap: 12px; border-radius: 14px;}
.library-result-card--compact .library-result-card__cover {width: 60px;}
.library-result-card--compact .library-result-card__title {font-size: 15px; line-height: 1.4; max-height: 2.8em;}
.library-result-card--compact .library-result-card__author, .library-result-card--compact .library-result-card__series {font-size: 12px;}
.library-result-card--compact .library-result-card__actions {padding-top: 8px; gap: 10px;}
.library-result-card--compact .library-result-card__actions > .q-btn {padding: 4px 12px;}
button:focus-visible, a:focus-visible {outline: 2px solid var(--app-primary); outline-offset: 3px;}
@media (max-width: 599px) {.library-result-card {padding: 14px; gap: 14px; border-radius: 16px;} .library-result-card__cover {width: 72px;} .library-result-card__title {font-size: 16px;} .library-result-card__author {font-size: 12px;} .library-result-card__actions {gap: 10px; padding-top: 10px;} .library-result-card__actions > .q-btn {padding: 6px 13px;}}
</style>
