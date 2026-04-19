<template>
    <div class="modern-title-list">
        <a ref="download" style="display: none;"></a>

        <LoadingMessage :message="loadingMessage" z-index="2" />
        <LoadingMessage :message="loadingMessage2" z-index="1" />

        <div v-if="tableData.length" class="catalog-grid">
            <div v-for="item in tableData" :key="item.key" class="catalog-card">
                <div class="cover-box" @click.stop.prevent="bookEvent({action: 'bookInfo', book: item.book})">
                    <img
                        v-if="coverByUid[item.book._uid]"
                        :src="coverByUid[item.book._uid]"
                        class="cover-img"
                        @error="clearCover(item.book._uid)"
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
    coverByUid = {};
    coverLoadToken = 0;

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

        this.tableData = result;
        this.preloadCovers();
    }

    async preloadCovers() {
        const token = ++this.coverLoadToken;
        const items = this.tableData.slice(0, coverPreloadLimit);

        for (const item of items) {
            if (token !== this.coverLoadToken)
                return;

            const uid = item.book._uid;
            if (!uid || this.coverByUid[uid] !== undefined)
                continue;

            this.coverByUid = Object.assign({}, this.coverByUid, {[uid]: ''});

            try {
                const response = await this.api.getBookInfo(uid);
                if (token !== this.coverLoadToken)
                    return;

                const cover = response.bookInfo && response.bookInfo.cover ? response.bookInfo.cover : '';
                this.coverByUid = Object.assign({}, this.coverByUid, {[uid]: cover});
            } catch(e) {
                this.coverByUid = Object.assign({}, this.coverByUid, {[uid]: ''});
            }
        }
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

    clearCover(uid) {
        if (!uid)
            return;

        this.coverByUid = Object.assign({}, this.coverByUid, {[uid]: ''});
    }
}

export default vueComponent(ModernTitleList);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.modern-title-list {
    padding: 14px 18px 24px;
}

.catalog-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 18px;
}

.catalog-card {
    background: var(--app-surface);
    border: 1px solid var(--app-border);
    border-radius: 8px;
    box-shadow: 0 14px 34px rgba(23, 32, 42, 0.10);
    overflow: hidden;
    transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}

.catalog-card:hover {
    transform: translateY(-3px);
    border-color: var(--app-primary);
    box-shadow: 0 20px 48px rgba(23, 32, 42, 0.16);
}

.cover-box {
    aspect-ratio: 2 / 3;
    background:
        linear-gradient(135deg, rgba(36, 119, 199, 0.20), rgba(201, 133, 0, 0.24)),
        var(--app-surface-2);
    cursor: pointer;
    overflow: hidden;
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
}

.cover-letter {
    width: 72px;
    height: 72px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.52);
    color: var(--app-accent);
    font-size: 42px;
    font-weight: 800;
}

.cover-ext {
    margin-top: 12px;
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0;
}

.card-body {
    padding: 12px 14px 14px;
}

.card-author {
    color: var(--app-accent);
    font-size: 12px;
    font-weight: 750;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.card-title {
    margin-top: 4px;
    color: var(--app-text);
    font-size: 16px;
    font-weight: 800;
    line-height: 1.2;
    min-height: 38px;
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
    border: 1px solid var(--app-border);
    border-radius: 8px;
    padding: 2px 7px;
    color: var(--app-muted);
    font-size: 11px;
    font-weight: 700;
}

.card-genre {
    margin-top: 10px;
    color: var(--app-muted);
    font-size: 12px;
    line-height: 1.3;
    min-height: 16px;
}

.card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    flex-wrap: wrap;
}

.card-variants {
    margin-top: 8px;
    color: var(--app-muted);
    font-size: 12px;
}
</style>
