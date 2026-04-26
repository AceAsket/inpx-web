<template>
    <div class="discovery-wrap q-mx-md q-mt-md q-mb-lg">
        <div class="discovery-page-head">
            <div class="discovery-page-copy">
                <div class="discovery-page-title">
                    {{ sectionTitle || 'Витрина' }}
                </div>
                <div class="discovery-page-subtitle">
                    Подборки по вашей библиотеке и профилю чтения
                </div>
            </div>

            <q-btn
                class="discovery-refresh-btn"
                color="primary"
                unelevated
                no-caps
                icon="la la-sync"
                :loading="loading"
                @click.stop.prevent="$emit('refresh-shelves')"
            >
                Обновить витрину
            </q-btn>
        </div>

        <div class="discovery-toolbar">
            <q-btn
                unelevated
                no-caps
                class="discovery-toolbar-btn"
                :class="{'discovery-toolbar-btn--active': compactMode}"
                :icon="compactMode ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                @click.stop.prevent="$emit('toggle-compact')"
            >
                {{ compactMode ? 'Обычные карточки' : 'Компактные карточки' }}
            </q-btn>

            <q-btn
                v-if="personalMode"
                unelevated
                no-caps
                class="discovery-toolbar-btn"
                :class="{'discovery-toolbar-btn--active': unreadOnly}"
                :icon="unreadOnly ? 'la la-filter' : 'la la-book-open'"
                @click.stop.prevent="$emit('toggle-unread-only')"
            >
                {{ unreadOnly ? 'Показывать все' : 'Только непрочитанное' }}
            </q-btn>

            <q-select
                v-if="showExternalFilter && externalGenreOptions && externalGenreOptions.length > 1"
                :model-value="externalGenreUrl"
                class="discovery-genre-select"
                dense
                outlined
                emit-value
                map-options
                options-dense
                no-error-icon
                :loading="loading"
                :disable="loading"
                label="Жанр внешней витрины"
                :options="externalGenreOptions"
                @update:model-value="$emit('set-external-genre', $event || '')"
            />

            <div v-if="showExternalPagination && externalPagination" class="discovery-filter-group">
                <q-btn
                    v-for="pageSize in [12, 24, 48]"
                    :key="pageSize"
                    unelevated
                    no-caps
                    class="discovery-toolbar-btn"
                    :class="{'discovery-toolbar-btn--active': externalPagination.perPage === pageSize}"
                    @click.stop.prevent="$emit('set-external-limit', pageSize)"
                >
                    {{ pageSize }}
                </q-btn>

            </div>
        </div>

        <div v-if="loading" class="discovery-loading-line">
            <q-icon class="la la-spinner icon-rotate" size="20px" />
            <span>Собираю витрину...</span>
        </div>

        <div v-if="errorMessage" class="discovery-error">
            {{ errorMessage }}
        </div>

        <section
            v-for="shelf in safeShelves"
            :key="shelf.id || shelf.title"
            class="discovery-shelf"
        >
            <div class="discovery-head">
                <div class="discovery-head-copy">
                    <div class="discovery-kicker">
                        {{ shelfSourceLabel(shelf) }}
                    </div>
                    <div class="discovery-title">
                        {{ shelf.title }}
                    </div>
                    <div v-if="shelf.subtitle" class="discovery-subtitle">
                        {{ shelf.subtitle }}
                    </div>
                    <div class="discovery-meta">
                        <span v-if="shelf.updatedAt">Обновлено {{ formatUpdatedAt(shelf.updatedAt) }}</span>
                        <span v-if="shelf.discoveryStale" class="discovery-meta-warning">Показан кеш</span>
                    </div>
                    <div v-if="shelf.discoveryRefreshError" class="discovery-meta-warning discovery-meta-warning--inline">
                        {{ shelf.discoveryRefreshError }}
                    </div>
                </div>

                <div class="discovery-head-actions">
                    <q-btn
                        v-if="shelf.canHide"
                        class="discovery-source-btn discovery-source-btn--hide"
                        unelevated
                        no-caps
                        icon="la la-eye-slash"
                        @click.stop.prevent="$emit('hide-shelf', shelf.id)"
                    >
                        Скрыть полку
                    </q-btn>

                    <q-btn
                        v-if="shelf.sourceUrl"
                        class="discovery-source-btn"
                        unelevated
                        no-caps
                        icon="la la-external-link-alt"
                        @click.stop.prevent="openSource(shelf)"
                    >
                        Источник
                    </q-btn>
                </div>
            </div>

            <div v-if="shelf.items && shelf.items.length" class="discovery-grid">
                <BookView
                    v-for="book in shelf.items"
                    :key="book._uid || `${shelf.id}-${book.id}`"
                    :book="book"
                    mode="extended"
                    :genre-map="genreMap"
                    :show-read-link="showReadLink"
                    :show-discovery-dismiss="!!book.discoveryDismissible"
                    :discovery-dismiss-label="book.discoveryDismissLabel || 'Неинтересно'"
                    :show-discovery-restore="!!book.discoveryRestoreable"
                    :discovery-restore-label="book.discoveryRestoreLabel || 'Вернуть'"
                    :compact-discovery="compactMode"
                    @book-event="bookEvent"
                />
            </div>

            <div v-if="showLoadMore(shelf)" class="discovery-load-more">
                <q-btn
                    class="discovery-source-btn"
                    unelevated
                    no-caps
                    icon="la la-plus-circle"
                    :loading="loading"
                    :disable="loading"
                    @click.stop.prevent="loadMore(shelf)"
                >
                    {{ loadMoreLabel(shelf) }}
                </q-btn>
            </div>

            <div v-if="!shelf.items || !shelf.items.length" class="discovery-empty">
                {{ shelf.emptyMessage || 'Пока пусто.' }}
            </div>
        </section>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import BaseList from '../BaseList';

class DiscoveryShelves extends BaseList {
    _props = {
        sectionTitle: String,
        compactMode: Boolean,
        personalMode: Boolean,
        externalFilter: { type: String, default: 'books'},
        externalGenreOptions: { type: Array, default: () => []},
        externalGenreUrl: { type: String, default: ''},
        showExternalFilter: Boolean,
        externalPagination: Object,
        showExternalPagination: Boolean,
        unreadOnly: Boolean,
        list: Object,
        search: Object,
        extSearch: Object,
        genreMap: Object,
        shelves: Array,
        loading: Boolean,
        errorMessage: String,
    };

    refresh() {
    }

    bookEvent(event) {
        if (event && event.action === 'discoveryDismiss') {
            this.$emit('dismiss-book', event.book);
            return;
        }

        if (event && event.action === 'discoveryRestore') {
            this.$emit('restore-book', event.book);
            return;
        }

        super.bookEvent(event);
    }

    loadMore(shelf = {}) {
        if (String(shelf.id || '') === 'similar-books') {
            this.$emit('load-more-recommendations');
            return;
        }

        this.$emit('load-more-external');
    }

    get safeShelves() {
        return (Array.isArray(this.shelves) ? this.shelves : []);
    }

    showLoadMore(shelf = {}) {
        const isExternalMore = !!(
            this.showExternalPagination
            && this.externalPagination
            && this.externalPagination.canNext
            && shelf
            && shelf.source === 'external'
            && Array.isArray(shelf.items)
            && shelf.items.length
        );

        const isSimilarMore = !!(
            this.personalMode
            && shelf
            && String(shelf.id || '') === 'similar-books'
            && shelf.discoveryHasMore === true
            && Array.isArray(shelf.items)
            && shelf.items.length
        );

        return isExternalMore || isSimilarMore;
    }

    loadMoreLabel(shelf = {}) {
        if (String(shelf.id || '') === 'similar-books')
            return 'Ещё рекомендации';
        return 'Загрузить ещё';
    }

    shelfSourceLabel(shelf = {}) {
        if (shelf.sourceName)
            return shelf.sourceName;
        if (shelf.source === 'external')
            return 'Внешний источник';
        return 'Локальная библиотека';
    }

    formatUpdatedAt(value) {
        const date = new Date(Number(value) || value);
        if (Number.isNaN(date.getTime()))
            return '';

        return date.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    openSource(shelf = {}) {
        if (shelf.sourceUrl)
            window.open(shelf.sourceUrl, '_blank');
    }
}

export default vueComponent(DiscoveryShelves);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.discovery-wrap {
    position: relative;
}

.discovery-page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
}

.discovery-page-copy {
    min-width: 0;
}

.discovery-page-title {
    color: var(--app-text);
    font-size: 32px;
    font-weight: 800;
    line-height: 1.05;
}

.discovery-page-subtitle {
    margin-top: 6px;
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
}

.discovery-refresh-btn {
    flex-shrink: 0;
}

.discovery-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 14px;
}

.discovery-filter-group {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 8px;
}

.discovery-toolbar-btn {
    color: var(--app-text);
    border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface) 88%, var(--app-surface-2) 12%);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--app-surface-3) 30%, white 70%) inset;
    font-weight: 600;
}

.discovery-toolbar-btn:hover {
    background: color-mix(in srgb, var(--app-surface) 72%, var(--app-surface-2) 28%);
    border-color: color-mix(in srgb, var(--app-border) 92%, var(--app-primary) 8%);
}

.discovery-toolbar-btn--active {
    color: color-mix(in srgb, var(--app-text) 82%, var(--app-primary) 18%);
    border-color: color-mix(in srgb, var(--app-border) 58%, var(--app-primary) 42%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 84%, var(--app-primary) 16%) 0%,
        color-mix(in srgb, var(--app-surface) 82%, var(--app-primary) 18%) 100%
    );
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary) 22%, transparent) inset;
}

.discovery-genre-select {
    min-width: 220px;
}

.discovery-genre-select :deep(.q-field__control) {
    border-radius: 14px;
    background: color-mix(in srgb, var(--app-surface) 90%, var(--app-surface-2) 10%);
}

.discovery-error {
    margin-bottom: 16px;
    padding: 14px 16px;
    border: 1px solid rgba(194, 88, 62, 0.28);
    border-radius: 18px;
    background: rgba(194, 88, 62, 0.08);
    color: var(--app-text);
    font-weight: 600;
}

.discovery-loading-line {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    color: var(--app-muted);
    font-weight: 700;
}

.discovery-shelf + .discovery-shelf {
    margin-top: 26px;
}

.discovery-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
}

.discovery-head-copy {
    min-width: 0;
}

.discovery-head-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.discovery-kicker {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
}

.discovery-title {
    margin-top: 4px;
    color: var(--app-text);
    font-size: 28px;
    font-weight: 800;
    line-height: 1.05;
}

.discovery-subtitle {
    margin-top: 6px;
    color: var(--app-muted);
    font-size: 14px;
    line-height: 1.35;
}

.discovery-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin-top: 8px;
    color: var(--app-muted);
    font-size: 13px;
    font-weight: 600;
}

.discovery-meta-warning {
    color: #a5522d;
}

.discovery-meta-warning--inline {
    margin-top: 6px;
    font-size: 13px;
    font-weight: 600;
}

.discovery-source-btn {
    flex-shrink: 0;
    color: var(--app-text);
    border: 1px solid color-mix(in srgb, var(--app-border) 78%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--app-surface) 88%, var(--app-surface-2) 12%);
    font-weight: 600;
}

.discovery-source-btn:hover {
    border-color: color-mix(in srgb, var(--app-border) 92%, var(--app-primary) 8%);
    background: color-mix(in srgb, var(--app-surface) 72%, var(--app-surface-2) 28%);
}

.discovery-source-btn--hide {
    color: color-mix(in srgb, var(--app-text) 74%, var(--app-danger) 26%);
    border-color: color-mix(in srgb, var(--app-border) 66%, var(--app-danger) 34%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 84%, var(--app-danger) 16%) 0%,
        color-mix(in srgb, var(--app-surface) 86%, var(--app-danger) 14%) 100%
    );
}

.discovery-source-btn--hide:hover {
    border-color: color-mix(in srgb, var(--app-border) 54%, var(--app-danger) 46%);
    background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--app-surface-2) 74%, var(--app-danger) 26%) 0%,
        color-mix(in srgb, var(--app-surface) 78%, var(--app-danger) 22%) 100%
    );
}

.discovery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 18px;
    align-items: stretch;
}

.discovery-load-more {
    display: flex;
    justify-content: center;
    margin-top: 18px;
}

.discovery-empty {
    padding: 16px 18px;
    border: 1px dashed var(--app-border);
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.44);
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
}

@media (max-width: 760px) {
    .discovery-wrap {
        margin-top: 10px;
    }

    .discovery-page-head {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }

    .discovery-head {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
    }

    .discovery-page-title {
        font-size: 24px;
    }

    .discovery-title {
        font-size: 22px;
    }

    .discovery-grid {
        grid-template-columns: 1fr;
        gap: 12px;
    }
}
</style>
