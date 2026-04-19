<template>
    <div class="modern-title-list">
        <a ref="download" style="display: none;"></a>

        <LoadingMessage :message="loadingMessage" z-index="2" />
        <LoadingMessage :message="loadingMessage2" z-index="1" />

        <div class="modern-filter-row row items-center">
            <div class="modern-filter-label">
                Топы
            </div>
            <q-btn-toggle
                :model-value="ratingPreset"
                :options="ratingOptions"
                toggle-color="primary"
                color="secondary"
                outline
                dense
                no-caps
                @update:model-value="applyRatingPreset"
            />
        </div>

        <div v-if="tableData.length" class="catalog-grid">
            <div v-for="item in tableData" :key="item.key" class="catalog-card">
                <div class="cover-box" @click.stop.prevent="bookEvent({action: 'bookInfo', book: item.book})">
                    <div v-if="itemRating(item)" class="cover-rating">
                        ★ {{ itemRating(item) }}
                    </div>
                    <img
                        v-if="coverByKey[item.key]"
                        :src="coverByKey[item.key]"
                        class="cover-img"
                        @error="coverError(item)"
                    />
                    <div v-else class="cover-placeholder">
                        <div class="cover-letter">
                            {{ coverLetter(item.book) }}
                        </div>
                        <div class="cover-ext">
                            {{ item.book.ext }}
                        </div>
                    </div>
                </div>

                <div class="card-body">
                    <div class="card-author clickable2" @click.stop.prevent="selectAuthor(item.book.author)">
                        {{ shortAuthor(item.book.author) }}
                    </div>

                    <div class="card-title clickable2" @click.stop.prevent="selectTitle(item.book.title)">
                        {{ item.book.title || 'Без названия' }}
                    </div>

                    <div v-if="item.book.series" class="card-series clickable2" @click.stop.prevent="selectSeries(item.book.series)">
                        {{ item.book.series }}{{ item.book.serno ? ` #${item.book.serno}` : '' }}
                    </div>

                    <div class="card-meta">
                        <span>{{ bookSize(item.book) }}</span>
                        <span>{{ item.book.ext }}</span>
                        <span v-if="item.book.lang">{{ item.book.lang }}</span>
                        <span v-if="item.book.librate">★ {{ item.book.librate }}</span>
                    </div>

                    <div v-if="showGenres && item.book.genre" class="card-genre">
                        {{ bookGenre(item.book) }}
                    </div>

                    <div class="card-actions">
                        <q-btn dense no-caps color="primary" label="Скачать" @click.stop.prevent="bookEvent({action: 'download', book: item.book})" />
                        <q-btn dense flat no-caps label="Инфо" @click.stop.prevent="bookEvent({action: 'bookInfo', book: item.book})" />
                        <q-btn dense flat round icon="la la-copy" @click.stop.prevent="bookEvent({action: 'copyLink', book: item.book})" />
                        <q-btn v-if="showReadLink" dense flat no-caps label="Читать" @click.stop.prevent="bookEvent({action: 'readBook', book: item.book})" />
                    </div>

                    <div v-if="item.books.length" class="card-variants">
                        +{{ item.books.length }} {{ item.books.length == 1 ? 'вариант' : 'варианта' }}
                    </div>
                </div>
            </div>
        </div>

        <div v-if="!refreshing && (!tableData.length || error)" class="row items-center q-ml-md" style="font-size: 120%">
            <q-icon class="la la-meh q-mr-xs" size="28px" />
            {{ (error ? error : 'Поиск не дал результатов') }}
        </div>
    </div>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';
import { reactive } from 'vue';

import BaseList from '../BaseList';

import * as utils from '../../../share/utils';

import _ from 'lodash';

const coverPreloadLimit = 24;

class ModernTitleList extends BaseList {
    coverByKey = {};
    coverAttemptByKey = {};
    embeddedCoverTriedByKey = {};
    coverLoadToken = 0;
    ratingOptions = [
        {label: 'Все', value: ''},
        {label: '5', value: '5'},
        {label: '4+', value: '4,5'},
        {label: '3+', value: '3,4,5'},
        {label: 'С оценкой', value: '1,2,3,4,5'},
    ];

    get foundCountMessage() {
        return `${this.list.totalFound} уникальн${utils.wordEnding(this.list.totalFound, 6)} назван${utils.wordEnding(this.list.totalFound, 3)}`;
    }

    async updateTableData() {
        let result = [];

        const title = this.searchResult.found;
        if (!title)
            return;

        let num = 0;
        for (const rec of title) {
            const item = reactive({
                key: rec.id,
                title: rec.title,
                num,

                book: false,
                books: [],
            });

            if (rec.books) {
                const filtered = this.filterBooks(rec.books);
                filtered.sort((a, b) => this.bookRating(b) - this.bookRating(a));

                for (let i = 0; i < filtered.length; i++) {
                    if (i === 0)
                        item.book = filtered[i];
                    else
                        item.books.push(filtered[i]);
                }

                if (filtered.length) {
                    num++;
                    result.push(item);
                }
            }
        }

        if (this.search.librate) {
            result.sort((a, b) => {
                let cmp = this.itemRating(b) - this.itemRating(a);
                if (cmp === 0)
                    cmp = a.title.localeCompare(b.title);
                return cmp;
            });
        }

        this.tableData = result;
        this.preloadCovers();
    }

    async preloadCovers() {
        const token = ++this.coverLoadToken;
        const items = this.tableData.slice(0, coverPreloadLimit);

        for (const item of items) {
            if (token !== this.coverLoadToken)
                return;

            if (this.coverByKey[item.key] !== undefined)
                continue;

            const cover = this.coverUrl(this.coverCandidates(item)[0]);
            if (cover) {
                this.coverAttemptByKey = Object.assign({}, this.coverAttemptByKey, {[item.key]: 0});
                this.coverByKey = Object.assign({}, this.coverByKey, {[item.key]: cover});
            } else {
                this.coverByKey = Object.assign({}, this.coverByKey, {[item.key]: ''});
                this.preloadEmbeddedCover(item);
            }
        }
    }

    coverUrl(book) {
        if (!book || !book.libid)
            return '';

        const rootRoute = (this.$root.getRootRoute ? this.$root.getRootRoute() : '');
        const prefix = (rootRoute && rootRoute !== '/' ? rootRoute : '');
        return `${prefix}/cover/${encodeURIComponent(book.libid)}`;
    }

    async coverError(item) {
        const candidates = this.coverCandidates(item);
        let attempt = (this.coverAttemptByKey[item.key] || 0) + 1;

        while (attempt < candidates.length) {
            const cover = this.coverUrl(candidates[attempt]);
            this.coverAttemptByKey = Object.assign({}, this.coverAttemptByKey, {[item.key]: attempt});
            attempt++;

            if (cover) {
                this.coverByKey = Object.assign({}, this.coverByKey, {[item.key]: cover});
                return;
            }
        }

        if (this.embeddedCoverTriedByKey[item.key]) {
            this.clearCover(item.key);
            return;
        }

        this.clearCover(item.key);
        this.preloadEmbeddedCover(item);
    }

    async preloadEmbeddedCover(item) {
        if (this.embeddedCoverTriedByKey[item.key])
            return;

        this.embeddedCoverTriedByKey = Object.assign({}, this.embeddedCoverTriedByKey, {[item.key]: true});

        for (const book of this.coverCandidates(item)) {
            try {
                const response = await this.api.getBookInfo(book._uid);
                const cover = response.bookInfo && response.bookInfo.cover ? response.bookInfo.cover : '';
                if (cover) {
                    this.coverByKey = Object.assign({}, this.coverByKey, {[item.key]: cover});
                    return;
                }
            } catch(e) {
                // Some variants may be missing or may not contain FB2 metadata.
            }
        }

        this.clearCover(item.key);
    }

    coverCandidates(item) {
        const books = [item.book, ...item.books].filter(book => book && book._uid);
        return books.sort((a, b) => {
            const afb2 = (a.ext || '').toLowerCase() === 'fb2' ? 0 : 1;
            const bfb2 = (b.ext || '').toLowerCase() === 'fb2' ? 0 : 1;
            return afb2 - bfb2;
        }).slice(0, 4);
    }

    async refresh() {
        const newQuery = this.getQuery();
        if (_.isEqual(newQuery, this.prevQuery))
            return;
        this.prevQuery = newQuery;

        this.queryExecute = newQuery;

        if (this.refreshing)
            return;

        this.error = '';
        this.refreshing = true;

        (async() => {
            await utils.sleep(500);
            if (this.refreshing)
                this.loadingMessage = 'Поиск книг...';
        })();

        try {
            while (this.queryExecute) {
                const query = this.queryExecute;
                this.queryExecute = null;

                try {
                    const response = await this.api.search('title', query);

                    this.list.queryFound = response.found.length;
                    this.list.totalFound = response.totalFound;
                    this.list.inpxHash = response.inpxHash;

                    this.searchResult = response;

                    await utils.sleep(1);
                    if (!this.queryExecute) {
                        await this.updateTableData();
                        this.scrollToTop();
                        this.highlightPageScroller(query);
                    }
                } catch (e) {
                    this.list.queryFound = 0;
                    this.list.totalFound = 0;
                    this.searchResult = {found: []};
                    await this.updateTableData();
                    this.error = `Ошибка: ${e.message}`;
                }
            }
        } finally {
            this.refreshing = false;
            this.loadingMessage = '';
        }
    }

    coverLetter(book) {
        const title = book.title || book.author || book.ext || '?';
        return title.substring(0, 1).toUpperCase();
    }

    shortAuthor(author) {
        if (!author)
            return 'Автор не указан';

        const authors = author.split(',');
        return authors.slice(0, 2).join(', ') + (authors.length > 2 ? ' и др.' : '');
    }

    bookSize(book) {
        let size = book.size/1024;
        let unit = 'KB';
        if (size > 1024) {
            size = size/1024;
            unit = 'MB';
        }
        return `${size.toFixed(0)} ${unit}`;
    }

    bookGenre(book) {
        if (!book.genre)
            return '';

        let result = [];
        const genre = book.genre.split(',');

        for (const g of genre) {
            const name = this.genreMap.get(g);
            if (name)
                result.push(name);
        }

        return result.slice(0, 3).join(' / ');
    }

    clearCover(key) {
        if (!key)
            return;

        this.coverByKey = Object.assign({}, this.coverByKey, {[key]: ''});
    }

    bookRating(book) {
        return parseInt(book && book.librate, 10) || 0;
    }

    itemRating(item) {
        const books = [item.book, ...item.books];
        return Math.max(...books.map(book => this.bookRating(book)));
    }

    get ratingPreset() {
        return this.search.librate || '';
    }

    applyRatingPreset(value) {
        this.search.librate = value || '';
    }
}

export default vueComponent(ModernTitleList);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.modern-title-list {
    padding: 18px 22px 28px;
}

.modern-filter-row {
    gap: 10px;
    margin-bottom: 18px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--app-surface) 86%, var(--app-primary));
    border: 1px solid color-mix(in srgb, var(--app-border) 75%, var(--app-primary));
    border-radius: 8px;
    box-shadow: 0 10px 28px rgba(23, 32, 38, 0.07);
}

.modern-filter-label {
    color: var(--app-text);
    font-size: 13px;
    font-weight: 800;
}

.catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
    gap: 22px;
}

.catalog-card {
    position: relative;
    background:
        linear-gradient(180deg, color-mix(in srgb, var(--app-surface) 96%, var(--app-primary)) 0%, var(--app-surface) 100%);
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, var(--app-primary));
    border-radius: 8px;
    box-shadow: 0 18px 44px rgba(23, 32, 38, 0.10);
    overflow: hidden;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background-color 0.18s ease;
}

.catalog-card:hover {
    transform: translateY(-4px);
    border-color: var(--app-primary);
    box-shadow: 0 24px 58px rgba(23, 32, 38, 0.17);
}

.cover-box {
    position: relative;
    aspect-ratio: 2 / 3;
    background:
        linear-gradient(145deg, rgba(15, 159, 143, 0.18), rgba(232, 93, 117, 0.14)),
        var(--app-surface-2);
    cursor: pointer;
    overflow: hidden;
}

.cover-box::after {
    content: '';
    position: absolute;
    inset: auto 0 0;
    height: 42%;
    background: linear-gradient(180deg, rgba(0, 0, 0, 0), rgba(10, 20, 24, 0.28));
    pointer-events: none;
}

.cover-rating {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1;
    padding: 4px 8px;
    border-radius: 8px;
    background: rgba(15, 23, 26, 0.72);
    color: #ffffff;
    font-size: 12px;
    font-weight: 850;
    backdrop-filter: blur(8px);
}

.cover-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.cover-placeholder {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--app-muted);
    background:
        radial-gradient(circle at 30% 24%, rgba(255, 255, 255, 0.52), transparent 32%),
        linear-gradient(145deg, rgba(15, 159, 143, 0.20), rgba(232, 93, 117, 0.16));
}

.cover-letter {
    width: 72px;
    height: 72px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.68);
    color: var(--app-primary);
    font-size: 42px;
    font-weight: 800;
    box-shadow: 0 12px 26px rgba(23, 32, 38, 0.12);
}

.cover-ext {
    margin-top: 12px;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0;
}

.card-body {
    padding: 14px 15px 15px;
}

.card-author {
    color: var(--app-primary);
    font-size: 12px;
    font-weight: 750;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.card-title {
    margin-top: 5px;
    color: var(--app-text);
    font-size: 17px;
    font-weight: 800;
    line-height: 1.24;
    min-height: 42px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.card-series {
    margin-top: 6px;
    color: var(--app-link);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
}

.card-meta span {
    border: 1px solid color-mix(in srgb, var(--app-border) 82%, var(--app-primary));
    border-radius: 8px;
    padding: 2px 7px;
    color: color-mix(in srgb, var(--app-muted) 82%, var(--app-primary));
    font-size: 11px;
    font-weight: 700;
    background: color-mix(in srgb, var(--app-surface) 88%, var(--app-primary));
}

.card-genre {
    margin-top: 10px;
    color: var(--app-muted);
    font-size: 12px;
    line-height: 1.3;
    min-height: 31px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

.card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    flex-wrap: wrap;
}

.card-actions .q-btn {
    box-shadow: none;
}

.card-variants {
    margin-top: 8px;
    color: var(--app-accent);
    font-size: 12px;
    font-weight: 750;
}
</style>
