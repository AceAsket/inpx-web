<template>
    <span v-if="rating" class="book-cover-rating" role="img" :aria-label="rating.description" :title="rating.description">
        <span class="book-cover-rating__score" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="12" height="12" focusable="false"><path fill="currentColor" d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" /></svg>
            <span>{{ rating.score }}</span>
        </span>
        <small v-if="rating.count" aria-hidden="true">{{ rating.count }} оц.</small>
    </span>
</template>

<script setup>
import {computed} from 'vue';
import {bookRating} from './bookRatingModel';
const props = defineProps({book: {type: Object, required: true}});
const rating = computed(() => bookRating(props.book));
</script>

<style scoped>
.book-cover-rating {position: absolute; top: 6px; right: 6px; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; max-width: calc(100% - 12px); padding: 4px 6px; border: 1px solid var(--app-border, #d6e3e3); border-radius: 7px; background: var(--app-surface, #fff); color: var(--app-text, #183236); box-shadow: 0 2px 7px #00000030; font-variant-numeric: tabular-nums; line-height: 1;}
.book-cover-rating__score {display: flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 650; white-space: nowrap;}
.book-cover-rating svg {color: var(--app-primary, #00796f); flex-shrink: 0;}
.book-cover-rating small {display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--app-muted, #52696d); font-size: 9px; line-height: 1.1; white-space: nowrap;}
:global(.body--dark) .book-cover-rating {background: var(--app-surface, #192a32); color: var(--app-text, #e3eff0); border-color: var(--app-border, #334a53);}
:global(.body--dark) .book-cover-rating svg {color: var(--app-primary, #6bdac9);}
:global(.body--dark) .book-cover-rating small {color: var(--app-muted, #abc0c5);}
</style>
