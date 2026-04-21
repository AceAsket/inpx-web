<template>
    <div
        ref="page"
        class="reader-page"
        :class="[readerThemeClass, {'reader-page--immersive': compactChromeHidden}]"
        :style="readerThemeStyle"
    >
        <div v-show="!compactChromeHidden" class="reader-toolbar">
            <div class="reader-toolbar-main">
                <q-btn
                    flat
                    no-caps
                    icon="la la-arrow-left"
                    class="reader-back-btn"
                    @click="goBack"
                >
                    {{ uiText.back }}
                </q-btn>

                <div class="reader-book-meta">
                    <div
                        class="reader-book-title"
                        :class="{'is-expanded': isCompactLayout && readerMetaExpanded}"
                        @click="toggleReaderMeta"
                    >
                        {{ title }}
                    </div>
                    <div
                        class="reader-book-author"
                        :class="{'is-expanded': isCompactLayout && readerMetaExpanded}"
                        @click="toggleReaderMeta"
                    >
                        {{ authorLine }}
                    </div>
                    <div
                        v-if="!isCompactLayout"
                        class="reader-book-progress"
                        :class="{'is-clickable': hasReaderPlaces}"
                        @click="hasReaderPlaces && openPlacesDialog(defaultPlacesTab)"
                    >
                        {{ readerProgressLabel }}<span v-if="readerPageMeta"> | {{ readerPageMeta }}</span><span v-if="readerSectionMeta"> &middot; {{ readerSectionMeta }}</span>
                    </div>
                </div>

                <div class="reader-toolbar-quick-actions">
                    <q-btn
                        v-if="hasPrevSection"
                        flat
                        dense
                        round
                        icon="la la-angle-left"
                        class="reader-icon-btn"
                        @click="jumpToAdjacentSection(-1)"
                    />
                    <q-btn
                        v-if="hasContents"
                        flat
                        dense
                        round
                        icon="la la-list"
                        class="reader-icon-btn"
                        @click="toggleContentsDialog"
                    />
                    <q-btn
                        flat
                        dense
                        round
                        icon="la la-bookmark"
                        class="reader-icon-btn"
                        @click="addCurrentBookmark"
                    />
                    <q-btn
                        flat
                        dense
                        round
                        :icon="fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                        class="reader-icon-btn"
                        @click="toggleFullscreen"
                    />
                    <q-btn
                        flat
                        dense
                        round
                        icon="la la-sliders-h"
                        class="reader-icon-btn"
                        :class="{'is-active': controlsOpen}"
                        @click="toggleControls"
                    />
                    <q-btn
                        v-if="hasNextSection"
                        flat
                        dense
                        round
                        icon="la la-angle-right"
                        class="reader-icon-btn"
                        @click="jumpToAdjacentSection(1)"
                    />
                </div>
            </div>

            <div v-show="showToolbarActions" class="reader-toolbar-actions">
                <div class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'dark'}" @click="setTheme('dark')">{{ uiText.themeDark }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'sepia'}" @click="setTheme('sepia')">{{ uiText.themeSepia }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'light'}" @click="setTheme('light')">{{ uiText.themeLight }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'eink'}" @click="setTheme('eink')">{{ uiText.themeEink }}</q-btn>
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-minus" @click="changeFontSize(-1)" />
                    <div class="reader-stepper-value">{{ activePreferences.fontSize }}px</div>
                    <q-btn flat dense round icon="la la-plus" @click="changeFontSize(1)" />
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-compress" @click="changeContentWidth(-40)" />
                    <div class="reader-stepper-value">{{ activePreferences.contentWidth }}px</div>
                    <q-btn flat dense round icon="la la-expand" @click="changeContentWidth(40)" />
                </div>

                <div class="reader-stepper">
                    <q-btn flat dense round icon="la la-minus" @click="changeLineHeight(-0.05)" />
                    <div class="reader-stepper-value">{{ activePreferences.lineHeight.toFixed(2) }}</div>
                    <q-btn flat dense round icon="la la-plus" @click="changeLineHeight(0.05)" />
                </div>

                <template v-if="preferences.theme === 'eink'">
                    <div class="reader-stepper">
                        <q-btn flat dense round icon="la la-minus" @click="changeEinkContrast(-4)" />
                        <div class="reader-stepper-value">{{ uiText.einkContrast }} {{ activePreferences.einkContrast }}%</div>
                        <q-btn flat dense round icon="la la-plus" @click="changeEinkContrast(4)" />
                    </div>

                    <div class="reader-stepper">
                        <q-btn flat dense round icon="la la-minus" @click="changeEinkPaperTone(-2)" />
                        <div class="reader-stepper-value">{{ uiText.einkPaper }} {{ activePreferences.einkPaperTone }}%</div>
                        <q-btn flat dense round icon="la la-plus" @click="changeEinkPaperTone(2)" />
                    </div>

                    <div class="reader-stepper">
                        <q-btn flat dense round icon="la la-minus" @click="changeEinkInkTone(2)" />
                        <div class="reader-stepper-value">{{ uiText.einkInk }} {{ 100 - activePreferences.einkInkTone }}%</div>
                        <q-btn flat dense round icon="la la-plus" @click="changeEinkInkTone(-2)" />
                    </div>
                </template>

                <div class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.readMode === 'scroll'}" @click="setReadMode('scroll')">{{ uiText.readModeScroll }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.readMode === 'paged'}" @click="setReadMode('paged')">{{ uiText.readModePages }}</q-btn>
                </div>

                <div v-if="activePreferences.readMode === 'paged'" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedNavigation === 'tap'}" @click="setPagedNavigation('tap')">{{ uiText.navTap }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedNavigation === 'wheel'}" @click="setPagedNavigation('wheel')">{{ uiText.navWheel }}</q-btn>
                </div>

                <div v-if="activePreferences.readMode === 'paged'" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedDirection === 'vertical'}" @click="setPagedDirection('vertical')">{{ uiText.directionVertical }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedDirection === 'horizontal'}" @click="setPagedDirection('horizontal')">{{ uiText.directionHorizontal }}</q-btn>
                </div>

                <div v-if="isCompactLayout" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.showStatusBar}" @click="setStatusBarVisible(true)">{{ uiText.statusBarOn }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': !activePreferences.showStatusBar}" @click="setStatusBarVisible(false)">{{ uiText.statusBarOff }}</q-btn>
                </div>

                <div class="reader-progress-text">
                    {{ progressPercent }}%<span v-if="activePreferences.readMode === 'paged' && totalPages > 1"> | {{ currentPage }}/{{ totalPages }}</span>
                </div>
            </div>
        </div>

        <div v-if="loading" class="reader-loading">
            <q-icon class="la la-spinner icon-rotate text-green-8" size="28px" />
            <div class="q-ml-sm">{{ uiText.loadingBook }}</div>
        </div>

        <div v-else-if="error" class="reader-error">
            {{ error }}
        </div>

        <div
            v-else
            ref="scroller"
            class="reader-scroll"
            :class="{
                'reader-scroll--paged': activePreferences.readMode === 'paged',
                'reader-scroll--paged-vertical': isVerticalPaged,
                'reader-scroll--paged-horizontal': isHorizontalPaged,
            }"
            @scroll="onScroll"
            @wheel="handleReaderWheel"
            @click="handleReaderTap"
            @touchstart.passive="handleReaderTouchStart"
            @touchend="handleReaderTouchEnd"
            @touchcancel="handleReaderTouchCancel"
        >
            <div
                class="reader-shell"
                :class="{
                    'reader-shell--paged': activePreferences.readMode === 'paged',
                    'reader-shell--paged-vertical': isVerticalPaged,
                    'reader-shell--paged-horizontal': isHorizontalPaged,
                }"
            >
                <div v-if="coverSrc && !isPagedMode" class="reader-cover-box">
                    <img :src="coverSrc" class="reader-cover" :alt="title" />
                </div>

                <div
                    ref="readerBody"
                    class="reader-body"
                    :class="{
                        'reader-body--paged': activePreferences.readMode === 'paged',
                        'reader-body--paged-vertical': isVerticalPaged,
                        'reader-body--paged-horizontal': isHorizontalPaged,
                    }"
                    :style="readerBodyStyle"
                >
                    <template v-if="!isPagedMode">
                        <div v-if="seriesLine" class="reader-series">
                            {{ seriesLine }}
                        </div>
                        <h1 class="reader-heading">
                            {{ title }}
                        </h1>
                        <div v-if="authorLine" class="reader-subheading">
                            {{ authorLine }}
                        </div>

                        <div v-if="hasContents && !isCompactLayout" class="reader-contents-inline">
                            <div class="reader-contents-inline-head">
                            <div class="reader-contents-inline-title">
                                {{ uiText.contents }}
                            </div>
                                <button class="reader-contents-toggle" @click="toggleInlineContents">
                                    {{ inlineContentsVisible ? uiText.hide : uiText.show }}
                                </button>
                            </div>
                            <div v-if="inlineContentsVisible" class="reader-contents-inline-list">
                                <button
                                    v-for="item in inlineContents"
                                    :key="item.id"
                                    class="reader-contents-chip"
                                    @click="jumpToContent(item.id)"
                                >
                                    {{ item.title }}
                                </button>
                            </div>
                        </div>

                        <div class="reader-progress-bar">
                            <div class="reader-progress-bar-fill" :style="{width: `${progressPercent}%`}"></div>
                        </div>

                        <div ref="readerHtml" class="reader-html" v-html="readerHtml"></div>
                    </template>

                    <template v-else>
                        <div class="reader-pages" :class="{'reader-pages--horizontal': isHorizontalPaged, 'reader-pages--vertical': isVerticalPaged}">
                            <transition :name="pagedTransitionName" mode="out-in">
                                <article
                                    v-if="activePagedPage"
                                    :key="`page-${currentPageIndex}-${activePagedPage.sectionId || 'page'}`"
                                    class="reader-page-sheet reader-page-sheet--live"
                                    :class="{'reader-page-sheet--horizontal': isHorizontalPaged, 'reader-page-sheet--vertical': isVerticalPaged}"
                                    :data-page-index="currentPageIndex"
                                >
                                    <div class="reader-html" v-html="activePagedPage.html"></div>
                                </article>
                            </transition>
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <div
            v-if="isPagedMode"
            ref="pageMeasure"
            class="reader-page-sheet reader-page-sheet--measure"
            :class="[readerThemeClass, {'reader-page-sheet--horizontal': isHorizontalPaged, 'reader-page-sheet--vertical': isVerticalPaged}]"
            :style="readerBodyStyle"
        >
            <div class="reader-html"></div>
        </div>

        <div v-if="isCompactLayout && (showCompactStatusBar || !compactChromeHidden)" class="reader-mobile-footer">
            <div v-if="showCompactStatusBar" class="reader-status-bar">
                <span>{{ compactStatusBarText }}</span>
            </div>

            <div v-if="!compactChromeHidden" class="reader-mobile-bar">
                <q-btn
                    flat
                    no-caps
                    icon="la la-bookmark"
                    class="reader-mobile-btn"
                    @click="openPlacesDialog(defaultPlacesTab)"
                >
                    {{ uiText.myPlaces }}
                </q-btn>
                <q-btn
                    v-if="hasContents"
                    flat
                    no-caps
                    icon="la la-list"
                    class="reader-mobile-btn"
                    @click="toggleContentsDialog"
                >
                    {{ uiText.contents }}
                </q-btn>
                <q-btn
                    flat
                    no-caps
                    icon="la la-sliders-h"
                    class="reader-mobile-btn"
                    :class="{'is-active': controlsOpen}"
                    @click="toggleControls"
                >
                    {{ uiText.settings }}
                </q-btn>
                <q-btn
                    flat
                    no-caps
                    :icon="fullscreenActive ? 'la la-compress-arrows-alt' : 'la la-expand-arrows-alt'"
                    class="reader-mobile-btn"
                    @click="toggleFullscreen"
                >
                    {{ uiText.screen }}
                </q-btn>
            </div>
        </div>

        <div v-if="fullscreenActive && contentsDialogOpen" class="reader-overlay-panel" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ uiText.contents }}</div>
                <q-btn flat dense round icon="la la-times" @click="contentsDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <button
                    v-for="item in displayContents"
                    :key="item.id"
                    class="reader-dialog-link"
                    :class="{'is-active': item.id === currentSectionId}"
                    @click="jumpToContent(item.id)"
                >
                    {{ item.title }}
                </button>
            </div>
        </div>

        <div v-if="fullscreenActive && bookmarksDialogOpen" class="reader-overlay-panel" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ uiText.myPlaces }}</div>
                <q-btn flat dense round icon="la la-times" @click="bookmarksDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <div class="reader-dialog-tabs">
                    <button
                        type="button"
                        class="reader-dialog-tab"
                        :class="{'is-active': currentPlacesTab === 'progress'}"
                        @click="currentPlacesTab = 'progress'"
                    >
                        {{ uiText.continueReading }}
                    </button>
                    <button
                        type="button"
                        class="reader-dialog-tab"
                        :class="{'is-active': currentPlacesTab === 'bookmarks'}"
                        @click="currentPlacesTab = 'bookmarks'"
                    >
                        {{ uiText.bookmarks }} <span v-if="plainBookmarks.length">{{ plainBookmarks.length }}</span>
                    </button>
                    <button
                        type="button"
                        class="reader-dialog-tab"
                        :class="{'is-active': currentPlacesTab === 'notes'}"
                        @click="currentPlacesTab = 'notes'"
                    >
                        {{ uiText.notes }} <span v-if="noteBookmarks.length">{{ noteBookmarks.length }}</span>
                    </button>
                </div>

                <div v-if="currentPlacesTab === 'progress'" class="reader-continue-card">
                    <div class="reader-continue-title">{{ currentSectionTitle || title }}</div>
                    <div class="reader-continue-meta">
                        {{ progressPercent }}%<span v-if="activePreferences.readMode === 'paged' && totalPages > 1"> | {{ currentPage }}/{{ totalPages }}</span>
                    </div>
                    <div v-if="progress.updatedAt" class="reader-continue-updated">{{ formatBookmarkDate(progress.updatedAt) }}</div>
                    <div class="reader-continue-actions">
                        <q-btn flat dense no-caps icon="la la-book-open" class="reader-inline-action-btn" @click="jumpToProgress">{{ uiText.continueReading }}</q-btn>
                        <q-btn flat dense no-caps icon="la la-bookmark" class="reader-inline-action-btn" @click="addCurrentBookmark">{{ uiText.bookmark }}</q-btn>
                    </div>
                </div>

                <template v-else-if="currentPlacesTab === 'bookmarks'">
                    <button
                        v-for="item in plainBookmarks"
                        :key="item.id"
                        class="reader-dialog-link reader-dialog-link--bookmark"
                        @click="jumpToBookmark(item)"
                    >
                        <span class="reader-dialog-link-text">
                            <span>{{ item.title }}</span>
                            <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                        </span>
                        <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                        <q-btn
                            flat
                            dense
                            round
                            icon="la la-trash"
                            class="reader-bookmark-delete"
                            @click.stop="removeBookmark(item.id)"
                        />
                    </button>
                    <div v-if="!plainBookmarks.length" class="reader-dialog-empty">{{ uiText.noBookmarks }}</div>
                </template>

                <template v-else>
                    <button
                        v-for="item in noteBookmarks"
                        :key="item.id"
                        class="reader-dialog-link reader-dialog-link--bookmark"
                        @click="jumpToBookmark(item)"
                    >
                        <span class="reader-dialog-link-text">
                            <span>{{ item.title }}</span>
                            <small v-if="item.note" class="reader-dialog-link-note">{{ item.note }}</small>
                            <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                        </span>
                        <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                        <q-btn
                            flat
                            dense
                            round
                            icon="la la-trash"
                            class="reader-bookmark-delete"
                            @click.stop="removeBookmark(item.id)"
                        />
                    </button>
                    <div v-if="!noteBookmarks.length" class="reader-dialog-empty">{{ uiText.noNotes }}</div>
                </template>
            </div>
        </div>

        <q-dialog v-if="!fullscreenActive" v-model="contentsDialogOpen" position="right">
            <div class="reader-dialog reader-dialog--contents" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">{{ uiText.contents }}</div>
                    <q-btn flat dense round icon="la la-times" @click="contentsDialogOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <button
                        v-for="item in displayContents"
                        :key="item.id"
                        class="reader-dialog-link"
                        :class="{'is-active': item.id === currentSectionId}"
                        @click="jumpToContent(item.id)"
                    >
                        {{ item.title }}
                    </button>
                </div>
            </div>
        </q-dialog>

        <q-dialog v-if="!fullscreenActive" v-model="bookmarksDialogOpen" position="right">
            <div class="reader-dialog reader-dialog--contents" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">{{ uiText.myPlaces }}</div>
                    <q-btn flat dense round icon="la la-times" @click="bookmarksDialogOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <div class="reader-dialog-tabs">
                        <button
                            type="button"
                            class="reader-dialog-tab"
                            :class="{'is-active': currentPlacesTab === 'progress'}"
                            @click="currentPlacesTab = 'progress'"
                        >
                            {{ uiText.continueReading }}
                        </button>
                        <button
                            type="button"
                            class="reader-dialog-tab"
                            :class="{'is-active': currentPlacesTab === 'bookmarks'}"
                            @click="currentPlacesTab = 'bookmarks'"
                        >
                            {{ uiText.bookmarks }} <span v-if="plainBookmarks.length">{{ plainBookmarks.length }}</span>
                        </button>
                        <button
                            type="button"
                            class="reader-dialog-tab"
                            :class="{'is-active': currentPlacesTab === 'notes'}"
                            @click="currentPlacesTab = 'notes'"
                        >
                            {{ uiText.notes }} <span v-if="noteBookmarks.length">{{ noteBookmarks.length }}</span>
                        </button>
                    </div>

                    <div v-if="currentPlacesTab === 'progress'" class="reader-continue-card">
                        <div class="reader-continue-title">{{ currentSectionTitle || title }}</div>
                        <div class="reader-continue-meta">
                            {{ progressPercent }}%<span v-if="activePreferences.readMode === 'paged' && totalPages > 1"> | {{ currentPage }}/{{ totalPages }}</span>
                        </div>
                        <div v-if="progress.updatedAt" class="reader-continue-updated">{{ formatBookmarkDate(progress.updatedAt) }}</div>
                        <div class="reader-continue-actions">
                            <q-btn flat dense no-caps icon="la la-book-open" class="reader-inline-action-btn" @click="jumpToProgress">{{ uiText.continueReading }}</q-btn>
                            <q-btn flat dense no-caps icon="la la-bookmark" class="reader-inline-action-btn" @click="addCurrentBookmark">{{ uiText.bookmark }}</q-btn>
                        </div>
                    </div>

                    <template v-else-if="currentPlacesTab === 'bookmarks'">
                        <button
                            v-for="item in plainBookmarks"
                            :key="item.id"
                            class="reader-dialog-link reader-dialog-link--bookmark"
                            @click="jumpToBookmark(item)"
                        >
                            <span class="reader-dialog-link-text">
                                <span>{{ item.title }}</span>
                                <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                            </span>
                            <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                            <q-btn
                                flat
                                dense
                                round
                                icon="la la-trash"
                                class="reader-bookmark-delete"
                                @click.stop="removeBookmark(item.id)"
                            />
                        </button>
                        <div v-if="!plainBookmarks.length" class="reader-dialog-empty">{{ uiText.noBookmarks }}</div>
                    </template>

                    <template v-else>
                        <button
                            v-for="item in noteBookmarks"
                            :key="item.id"
                            class="reader-dialog-link reader-dialog-link--bookmark"
                            @click="jumpToBookmark(item)"
                        >
                            <span class="reader-dialog-link-text">
                                <span>{{ item.title }}</span>
                                <small v-if="item.note" class="reader-dialog-link-note">{{ item.note }}</small>
                                <small v-if="item.excerpt" class="reader-dialog-link-subtext">{{ item.excerpt }}</small>
                            </span>
                            <span class="reader-dialog-link-meta">{{ Math.round((Number(item.percent || 0) || 0) * 100) }}%</span>
                            <q-btn
                                flat
                                dense
                                round
                                icon="la la-trash"
                                class="reader-bookmark-delete"
                                @click.stop="removeBookmark(item.id)"
                            />
                        </button>
                        <div v-if="!noteBookmarks.length" class="reader-dialog-empty">{{ uiText.noNotes }}</div>
                    </template>
                </div>
            </div>
        </q-dialog>

        <q-dialog v-model="bookmarkComposerOpen">
            <div class="reader-dialog reader-dialog--composer" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">{{ uiText.newPlace }}</div>
                    <q-btn flat dense round icon="la la-times" @click="bookmarkComposerOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <div class="reader-compose-title">{{ bookmarkDraft.title || title }}</div>
                    <div v-if="bookmarkDraft.excerpt" class="reader-compose-excerpt">{{ bookmarkDraft.excerpt }}</div>
                    <q-input
                        class="reader-compose-input"
                        v-model="bookmarkDraft.note"
                        outlined
                        autogrow
                        type="textarea"
                        :label="uiText.noteLabel"
                    />
                    <div class="reader-compose-actions">
                        <q-btn flat dense no-caps icon="la la-bookmark" class="reader-inline-action-btn" @click="saveBookmarkDraft('bookmark')">{{ uiText.simpleBookmark }}</q-btn>
                        <q-btn flat dense no-caps icon="la la-sticky-note" class="reader-inline-action-btn" @click="saveBookmarkDraft('note')">{{ uiText.saveAsNote }}</q-btn>
                    </div>
                </div>
            </div>
        </q-dialog>
    </div>
</template>

<script>
import vueComponent from '../vueComponent.js';
import Fb2Parser from '../../../server/core/fb2/Fb2Parser';
import _ from 'lodash';

const componentOptions = {
    watch: {
        '$route.query.bookUid': {
            immediate: true,
            handler() {
                this.loadReader();// no await
            },
        },
    },
};

class Reader {
    _options = componentOptions;

    loading = false;
    error = '';
    bookInfo = null;
    title = '';
    authorLine = '';
    seriesLine = '';
    coverSrc = '';
    readerHtml = '';
    pagedPages = [];
    currentPageIndex = 0;
    controlsOpen = false;
    contentsDialogOpen = false;
    bookmarksDialogOpen = false;
    bookmarkComposerOpen = false;
    inlineContentsVisible = false;
    fullscreenActive = false;
    chromeHidden = false;
    readerMetaExpanded = false;
    resizeObserver = null;
    scrollerViewportWidth = 0;
    scrollerViewportHeight = 0;
    contents = [];
    bookmarks = [];
    currentPlacesTab = 'progress';
    currentSectionId = '';
    bookmarkDraft = {
        title: '',
        excerpt: '',
        note: '',
        percent: 0,
        sectionId: '',
    };
    preferences = {
        theme: 'dark',
        readMode: 'scroll',
        pagedNavigation: 'tap',
        pagedDirection: 'vertical',
        showStatusBar: true,
        fontSize: 18,
        lineHeight: 1.7,
        contentWidth: 820,
        einkProfile: {
            readMode: 'paged',
            pagedNavigation: 'tap',
            pagedDirection: 'vertical',
            showStatusBar: true,
            fontSize: 19,
            lineHeight: 1.8,
            contentWidth: 760,
            einkContrast: 92,
            einkPaperTone: 94,
            einkInkTone: 10,
        },
    };
    progress = {
        percent: 0,
        sectionId: '',
        updatedAt: '',
    };
    restorePending = false;
    saveProgressDebounced = null;
    savePreferencesDebounced = null;
    snapTimer = null;
    pageTurnTimer = null;
    pageTurnAnimating = false;
    pageTurnDirection = 1;
    touchStartPoint = null;

    created() {
        this.handleBeforeUnload = () => {
            this.flushProgress();
        };
        this.handleFullscreenChange = () => {
            this.fullscreenActive = !!document.fullscreenElement;
        };
        this.handleWindowResize = () => {
            this.updateScrollerViewport();
        };

        this.saveProgressDebounced = _.debounce(() => {
            this.persistProgress();// no await
        }, 800);

        this.savePreferencesDebounced = _.debounce(() => {
            this.persistPreferences();// no await
        }, 500);
    }

    mounted() {
        window.addEventListener('beforeunload', this.handleBeforeUnload);
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);
        window.addEventListener('resize', this.handleWindowResize);
        this.handleFullscreenChange();
        this.$nextTick(() => {
            this.attachScrollerObserver();
            this.updateScrollerViewport();
        });
    }

    deactivated() {
        this.flushProgress();
        this.clearSnapTimer();
        clearTimeout(this.pageTurnTimer);
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    beforeUnmount() {
        window.removeEventListener('beforeunload', this.handleBeforeUnload);
        document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
        window.removeEventListener('resize', this.handleWindowResize);
        this.detachScrollerObserver();
        this.clearSnapTimer();
        clearTimeout(this.pageTurnTimer);
        this.flushProgress();
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
    }

    get bookUid() {
        return String(this.$route.query.bookUid || this.$route.params.bookUid || '').trim();
    }

    get readerThemeClass() {
        return `reader-theme-${this.preferences.theme || 'dark'}`;
    }

    get activePreferences() {
        return (this.preferences.theme === 'eink')
            ? Object.assign({}, this.preferences, this.preferences.einkProfile || {})
            : this.preferences;
    }

    get readerThemeStyle() {
        if (this.preferences.theme !== 'eink')
            return {};

        const contrast = Math.max(72, Math.min(100, Number(this.activePreferences.einkContrast || 92) || 92));
        const paperTone = Math.max(84, Math.min(99, Number(this.activePreferences.einkPaperTone || 94) || 94));
        const inkTone = Math.max(4, Math.min(26, Number(this.activePreferences.einkInkTone || 10) || 10));
        const accentSoftAlpha = Math.max(0.03, Math.min(0.16, (100 - contrast) / 240));
        const borderAlpha = Math.max(0.1, Math.min(0.28, (contrast - 60) / 160));
        const mutedTone = Math.max(28, Math.min(48, inkTone + 24));

        return {
            '--reader-eink-bg': `hsl(48 18% ${Math.max(80, paperTone - 4)}%)`,
            '--reader-eink-surface': `hsl(48 20% ${paperTone}%)`,
            '--reader-eink-surface-2': `hsl(48 16% ${Math.max(82, paperTone - 5)}%)`,
            '--reader-eink-text': `hsl(40 10% ${inkTone}%)`,
            '--reader-eink-muted': `hsl(40 8% ${mutedTone}%)`,
            '--reader-eink-border': `rgba(20, 20, 20, ${borderAlpha.toFixed(3)})`,
            '--reader-eink-accent-soft': `rgba(20, 20, 20, ${accentSoftAlpha.toFixed(3)})`,
        };
    }

    get readerDialogStyle() {
        if (this.preferences.theme === 'eink')
            return this.readerThemeStyle;

        const theme = String(this.preferences.theme || 'dark');
        if (theme === 'sepia') {
            return {
                '--reader-bg': '#f4ecdd',
                '--reader-surface': '#fbf6ec',
                '--reader-surface-2': '#efe4d2',
                '--reader-text': '#402f20',
                '--reader-muted': '#7c6855',
                '--reader-border': 'rgba(64, 47, 32, 0.16)',
                '--reader-accent': '#b76a2c',
                '--reader-accent-soft': 'rgba(183, 106, 44, 0.12)',
            };
        }

        if (theme === 'light') {
            return {
                '--reader-bg': '#f7fafc',
                '--reader-surface': '#ffffff',
                '--reader-surface-2': '#eef3f7',
                '--reader-text': '#1f2a33',
                '--reader-muted': '#60707d',
                '--reader-border': 'rgba(96, 112, 125, 0.18)',
                '--reader-accent': '#0f9f8f',
                '--reader-accent-soft': 'rgba(15, 159, 143, 0.12)',
            };
        }

        return {
            '--reader-bg': '#12171b',
            '--reader-surface': '#182127',
            '--reader-surface-2': '#222c33',
            '--reader-text': '#edf2f5',
            '--reader-muted': '#9db0bc',
            '--reader-border': 'rgba(157, 176, 188, 0.22)',
            '--reader-accent': '#5eead4',
            '--reader-accent-soft': 'rgba(94, 234, 212, 0.12)',
        };
    }

    get readerDialogSurfaceStyle() {
        return Object.assign({}, this.readerDialogStyle, {
            background: 'var(--reader-surface)',
            color: 'var(--reader-text)',
        });
    }

    get readerNotifyOptions() {
        return {
            color: 'white',
            icon: 'la la-bookmark',
            iconColor: 'var(--reader-text)',
            messageColor: 'var(--reader-text)',
            captionColor: 'var(--reader-text)',
            position: (this.isCompactLayout ? 'bottom' : 'top-right'),
            textColor: 'black',
            style: `
                background: var(--reader-surface);
                color: var(--reader-text);
                border: 1px solid var(--reader-border);
                border-radius: 18px;
                box-shadow: 0 18px 42px rgba(0, 0, 0, 0.18);
            `,
        };
    }

    get progressPercent() {
        return Math.round((Number(this.progress.percent || 0) || 0) * 100);
    }

    get readerProgressLabel() {
        return `${this.uiText.readPrefix} ${this.progressPercent}%`;
    }


    get uiText() {
        return {
            back: '\u041d\u0430\u0437\u0430\u0434',
            myPlaces: '\u041c\u043e\u0438 \u043c\u0435\u0441\u0442\u0430',
            continueReading: '\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c',
            bookmarks: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0438',
            notes: '\u0417\u0430\u043c\u0435\u0442\u043a\u0438',
            bookmark: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            noBookmarks: '\u0423 \u044d\u0442\u043e\u0439 \u043a\u043d\u0438\u0433\u0438 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0440\u0443\u0447\u043d\u044b\u0445 \u0437\u0430\u043a\u043b\u0430\u0434\u043e\u043a.',
            noNotes: '\u0417\u0430\u043c\u0435\u0442\u043e\u043a \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.',
            newPlace: '\u041d\u043e\u0432\u043e\u0435 \u043c\u0435\u0441\u0442\u043e',
            noteLabel: '\u0417\u0430\u043c\u0435\u0442\u043a\u0430',
            simpleBookmark: '\u041f\u0440\u043e\u0441\u0442\u0430\u044f \u0437\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            saveAsNote: '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u0430\u043a \u0437\u0430\u043c\u0435\u0442\u043a\u0443',
            readPrefix: '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e',
            bookmarkAdded: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u0430',
            noteSaved: '\u0417\u0430\u043c\u0435\u0442\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430',
            bookmarkTitle: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            error: '\u041e\u0448\u0438\u0431\u043a\u0430',
            themeDark: '\u0422\u0451\u043c\u043d\u0430\u044f',
            themeSepia: '\u0421\u0435\u043f\u0438\u044f',
            themeLight: '\u0421\u0432\u0435\u0442\u043b\u0430\u044f',
            themeEink: 'eink',
            readModeScroll: '\u041b\u0435\u043d\u0442\u0430',
            readModePages: '\u0421\u0442\u0440\u0430\u043d\u0438\u0446\u044b',
            navTap: '\u041a\u0430\u0441\u0430\u043d\u0438\u0435',
            navWheel: '\u041a\u043e\u043b\u0435\u0441\u043e',
            directionVertical: '\u0412\u0435\u0440\u0442\u0438\u043a\u0430\u043b\u044c\u043d\u043e',
            directionHorizontal: '\u0413\u043e\u0440\u0438\u0437\u043e\u043d\u0442\u0430\u043b\u044c\u043d\u043e',
            statusBarOn: '\u0421\u0442\u0430\u0442\u0443\u0441 \u0432\u043d\u0438\u0437\u0443',
            statusBarOff: '\u0411\u0435\u0437 \u0441\u0442\u0430\u0442\u0443\u0441\u0430',
            einkContrast: '\u041a\u043e\u043d\u0442\u0440\u0430\u0441\u0442',
            einkPaper: '\u0411\u0443\u043c\u0430\u0433\u0430',
            einkInk: '\u0427\u0435\u0440\u043d\u0438\u043b\u0430',
            loadingBook: '\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430 \u043a\u043d\u0438\u0433\u0438...',
            contents: '\u0421\u043e\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435',
            show: '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c',
            hide: '\u0421\u043a\u0440\u044b\u0442\u044c',
            settings: '\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',
            screen: '\u042d\u043a\u0440\u0430\u043d',
        };
    }

    get compactProgressHint() {
        return (this.activePreferences.readMode === 'paged' && this.totalPages > 1)
            ? `${this.progressPercent}% | ${this.currentPage}/${this.totalPages}`
            : `${this.progressPercent}%`;
    }

    get compactStatusBarText() {
        return (this.activePreferences.readMode === 'paged')
            ? `${this.readerProgressLabel} | ${this.currentPage}/${this.totalPages}`
            : this.readerProgressLabel;
    }

    get activePagedPage() {
        if (!this.isPagedMode || !this.pagedPages.length)
            return null;

        return this.pagedPages[Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex))] || null;
    }

    get pagedTransitionName() {
        if (this.isHorizontalPaged)
            return (this.pageTurnDirection < 0 ? 'reader-page-slide-x-back' : 'reader-page-slide-x-forward');

        return (this.pageTurnDirection < 0 ? 'reader-page-slide-y-back' : 'reader-page-slide-y-forward');
    }

    get readerPageMeta() {
        return (this.activePreferences.readMode === 'paged')
            ? `${this.currentPage}/${this.totalPages}`
            : '';
    }

    get readerSectionMeta() {
        return (this.isCompactLayout ? '' : this.currentSectionTitle);
    }

    get showCompactStatusBar() {
        return this.isCompactLayout && !!this.activePreferences.showStatusBar;
    }

    get isPagedMode() {
        return this.activePreferences.readMode === 'paged';
    }

    get isHorizontalPaged() {
        return this.isPagedMode && this.activePreferences.pagedDirection === 'horizontal';
    }

    get isVerticalPaged() {
        return this.isPagedMode && !this.isHorizontalPaged;
    }

    get pagedMetrics() {
        const pageOffsets = this.pageOffsets;
        const totalPages = Math.max(1, this.pagedPages.length || pageOffsets.length);
        const pageSize = 1;
        const maxScroll = Math.max(0, totalPages - 1);

        return {pageSize, maxScroll, totalPages, pageOffsets};
    }

    get pageOffsets() {
        if (!this.isPagedMode)
            return [0];

        return (this.pagedPages.length
            ? this.pagedPages.map((_, index) => index)
            : [0]);
    }

    get currentPagedPageIndex() {
        if (!this.isPagedMode)
            return 0;

        return Math.max(0, Math.min(this.totalPages - 1, this.currentPageIndex));
    }

    get totalPages() {
        const scroller = this.$refs ? this.$refs.scroller : null;
        if (this.isPagedMode)
            return Math.max(1, this.pagedPages.length);

        if (!scroller || !(this.scrollerViewportHeight || scroller.clientHeight))
            return 1;

        return Math.max(1, Math.ceil(scroller.scrollHeight / scroller.clientHeight));
    }

    get currentPage() {
        if (this.isPagedMode)
            return Math.min(this.totalPages, Math.max(1, this.currentPagedPageIndex + 1));

        const scroller = this.$refs ? this.$refs.scroller : null;
        if (!scroller || !(this.scrollerViewportHeight || scroller.clientHeight))
            return 1;

        return Math.min(this.totalPages, Math.max(1, Math.floor(scroller.scrollTop / scroller.clientHeight) + 1));
    }

    get readerBodyStyle() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        const pagePaddingX = (this.isCompactLayout ? 28 : 64);
        const pageColumnWidth = Math.max(180, this.pageFrameWidth - pagePaddingX - 2);
        return {
            '--reader-font-size': `${this.activePreferences.fontSize}px`,
            '--reader-line-height': String(this.activePreferences.lineHeight),
            '--reader-content-width': `${this.activePreferences.contentWidth}px`,
            '--reader-page-min-height': `${Math.max(360, this.pageMinHeight || (scrollerHeight - 56))}px`,
            '--reader-page-gap': `${this.pageGap}px`,
            '--reader-page-frame-width': `${this.pageFrameWidth}px`,
            '--reader-page-column-width': `${pageColumnWidth}px`,
            '--reader-page-padding': (this.isCompactLayout ? '14px 14px 20px' : '28px 32px 34px'),
        };
    }

    get pageGap() {
        if (this.isHorizontalPaged)
            return 0;
        return (this.isCompactLayout ? 18 : 32);
    }

    get pageFrameWidth() {
        const scrollerWidth = (this.scrollerViewportWidth || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientWidth) || 0));
        if (this.isHorizontalPaged)
            return Math.max(280, scrollerWidth || 280);
        const reservedGap = (this.isCompactLayout ? 16 : 120);
        return Math.max(280, Math.min(this.activePreferences.contentWidth, Math.max(280, scrollerWidth - reservedGap)));
    }

    get pageMinHeight() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        const chromeOffset = (this.isCompactLayout ? 96 : 72);
        return Math.max(360, scrollerHeight - chromeOffset);
    }

    get isCompactLayout() {
        return !!(this.$q && this.$q.screen && this.$q.screen.lt && this.$q.screen.lt.md);
    }

    get compactChromeHidden() {
        return this.isCompactLayout && this.chromeHidden;
    }

    get showToolbarActions() {
        return this.controlsOpen;
    }

    get displayContents() {
        return this.contents.slice(0, 120);
    }

    get inlineContents() {
        return this.displayContents.slice(0, 12);
    }

    get hasContents() {
        return this.displayContents.length > 0;
    }

    get hasBookmarks() {
        return this.bookmarks.length > 0;
    }

    get hasSavedProgress() {
        return !!(this.progress && (
            String(this.progress.sectionId || '').trim()
            || Number(this.progress.percent || 0) > 0
            || String(this.progress.updatedAt || '').trim()
        ));
    }

    get hasReaderPlaces() {
        return this.hasSavedProgress || this.hasBookmarks;
    }

    get defaultPlacesTab() {
        if (this.hasSavedProgress)
            return 'progress';
        if (this.plainBookmarks.length)
            return 'bookmarks';
        if (this.noteBookmarks.length)
            return 'notes';
        return 'progress';
    }

    get plainBookmarks() {
        return this.bookmarks.filter((item) => !String(item.note || '').trim());
    }

    get noteBookmarks() {
        return this.bookmarks.filter((item) => String(item.note || '').trim());
    }

    get currentSectionTitle() {
        const current = this.contents.find((item) => item.id === this.currentSectionId);
        return (current ? current.title : '');
    }

    get currentSectionIndex() {
        return this.contents.findIndex((item) => item.id === this.currentSectionId);
    }

    get hasPrevSection() {
        return this.currentSectionIndex > 0;
    }

    get hasNextSection() {
        return this.currentSectionIndex >= 0 && this.currentSectionIndex < this.contents.length - 1;
    }

    goBack() {
        if (window.history.length > 1)
            this.$router.back();
        else
            this.$router.push('/');
    }

    toggleControls() {
        this.controlsOpen = !this.controlsOpen;
    }

    toggleContentsDialog() {
        this.contentsDialogOpen = !this.contentsDialogOpen;
    }

    toggleInlineContents() {
        this.inlineContentsVisible = !this.inlineContentsVisible;
    }

    toggleReaderMeta() {
        if (!this.isCompactLayout)
            return;
        this.readerMetaExpanded = !this.readerMetaExpanded;
    }

    toggleBookmarksDialog(tab = '') {
        if (tab)
            this.currentPlacesTab = tab;
        this.bookmarksDialogOpen = !this.bookmarksDialogOpen;
    }

    openPlacesDialog(tab = '') {
        this.currentPlacesTab = (tab || this.defaultPlacesTab);
        this.bookmarksDialogOpen = true;
    }

    setReadMode(mode = 'scroll') {
        this.updateActivePreferences({
            readMode: (mode === 'paged' ? 'paged' : 'scroll'),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    setPagedNavigation(mode = 'tap') {
        this.updateActivePreferences({
            pagedNavigation: (mode === 'wheel' ? 'wheel' : 'tap'),
        });
        this.savePreferencesDebounced();
    }

    setPagedDirection(direction = 'vertical') {
        this.updateActivePreferences({
            pagedDirection: (direction === 'horizontal' ? 'horizontal' : 'vertical'),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    setStatusBarVisible(enabled = true) {
        this.updateActivePreferences({
            showStatusBar: !!enabled,
        });
        this.savePreferencesDebounced();
    }

    changeEinkContrast(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkContrast: Math.max(72, Math.min(100, (Number(this.activePreferences.einkContrast || 92) || 92) + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeEinkPaperTone(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkPaperTone: Math.max(84, Math.min(99, (Number(this.activePreferences.einkPaperTone || 94) || 94) + delta)),
        });
        this.savePreferencesDebounced();
    }

    changeEinkInkTone(delta = 0) {
        if (this.preferences.theme !== 'eink')
            return;
        this.updateActivePreferences({
            einkInkTone: Math.max(4, Math.min(26, (Number(this.activePreferences.einkInkTone || 10) || 10) + delta)),
        });
        this.savePreferencesDebounced();
    }

    updateActivePreferences(patch = {}) {
        if (this.preferences.theme === 'eink') {
            this.preferences = Object.assign({}, this.preferences, {
                einkProfile: Object.assign({}, this.preferences.einkProfile || {}, patch),
            });
            return;
        }

        this.preferences = Object.assign({}, this.preferences, patch);
    }

    attachScrollerObserver() {
        this.detachScrollerObserver();
        if (typeof ResizeObserver === 'undefined' || !this.$refs || !this.$refs.scroller)
            return;

        this.resizeObserver = new ResizeObserver(() => {
            this.updateScrollerViewport();
        });
        this.resizeObserver.observe(this.$refs.scroller);
    }

    detachScrollerObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    updateScrollerViewport() {
        const scroller = (this.$refs ? this.$refs.scroller : null);
        this.scrollerViewportWidth = ((scroller && scroller.clientWidth) || 0);
        this.scrollerViewportHeight = ((scroller && scroller.clientHeight) || 0);
        if (this.isPagedMode) {
            this.buildPagedPages();
            this.syncPagedProgress(false);
        }
        this.applyVerticalSectionAlignment();
    }

    reflowReaderLayout() {
        this.restorePending = true;
        this.clearSnapTimer();
        this.$nextTick(() => {
            requestAnimationFrame(() => {
                if (this.$refs && this.$refs.scroller) {
                    this.$refs.scroller.scrollLeft = 0;
                    this.$refs.scroller.scrollTop = 0;
                }
                if (this.isPagedMode)
                    this.currentPageIndex = 0;
                this.updateScrollerViewport();
                requestAnimationFrame(() => {
                    this.updateScrollerViewport();
                    this.restoreProgress();
                });
            });
        });
    }

    clearSnapTimer() {
        if (this.snapTimer) {
            clearTimeout(this.snapTimer);
            this.snapTimer = null;
        }
    }

    applyVerticalSectionAlignment() {
        const readerBody = (this.$refs ? this.$refs.readerBody : null);
        if (!readerBody)
            return;

        if (this.isPagedMode)
            return;

        const sections = Array.from(readerBody.querySelectorAll('.reader-section-block'));
        if (!sections.length)
            return;

        for (const section of sections)
            section.style.marginTop = '';

        if (!this.isVerticalPaged)
            return;

        const pageSize = Math.max(1, this.scrollerViewportHeight || this.pageMinHeight || 1);
        if (pageSize <= 1)
            return;

        const baseSpacing = 18;
        for (let index = 1; index < sections.length; index += 1) {
            const section = sections[index];
            const offsetTop = section.offsetTop;
            const remainder = offsetTop % pageSize;
            const extraSpacing = (remainder <= 2 ? 0 : (pageSize - remainder));
            section.style.marginTop = `${baseSpacing + extraSpacing}px`;
        }
    }

    getDeepestLastElement(root) {
        if (!root || !root.lastElementChild)
            return null;

        let node = root.lastElementChild;
        while (node && node.lastElementChild)
            node = node.lastElementChild;
        return node || null;
    }

    measurePagedContentSize() {
        if (!this.$refs || !this.$refs.readerBody)
            return 0;

        const readerBody = this.$refs.readerBody;
        const scroller = (this.$refs ? this.$refs.scroller : null);
        const contentRoot = readerBody.querySelector('.reader-html') || readerBody;
        const style = window.getComputedStyle(readerBody);

        if (this.isVerticalPaged) {
            const blocks = [readerBody, contentRoot]
                .concat(Array.from(contentRoot.querySelectorAll('*')));
            const padBottom = parseFloat(style.paddingBottom || '0') || 0;
            const maxBottom = blocks.reduce((acc, node) => (
                Math.max(acc, (node.offsetTop || 0) + (node.offsetHeight || 0))
            ), 0);

            return Math.max(
                maxBottom + padBottom,
                contentRoot.scrollHeight || 0,
                readerBody.scrollHeight || 0,
                (scroller && scroller.scrollHeight) || 0,
            );
        }

        const tailNode = this.getDeepestLastElement(contentRoot);
        if (!tailNode || !tailNode.getBoundingClientRect)
            return 0;

        const bodyRect = readerBody.getBoundingClientRect();
        const tailRect = tailNode.getBoundingClientRect();
        const padEnd = parseFloat(
            this.isHorizontalPaged
                ? (style.paddingRight || '0')
                : (style.paddingBottom || '0'),
        ) || 0;
        const intrinsicContentSize = Math.max(
            0,
            (this.isHorizontalPaged
                ? (contentRoot.scrollWidth || 0)
                : (contentRoot.scrollHeight || 0)),
        );

        return Math.max(
            0,
            intrinsicContentSize,
            (this.isHorizontalPaged
                ? (tailRect.right - bodyRect.left)
                : (tailRect.bottom - bodyRect.top)) + padEnd,
            (scroller && scroller.scrollWidth) || 0,
        );
    }

    doesPagedMeasureOverflow(measureHost) {
        if (!measureHost)
            return false;

        if (this.isHorizontalPaged)
            return measureHost.scrollWidth > measureHost.clientWidth + 2;

        return measureHost.scrollHeight > measureHost.clientHeight + 2;
    }

    getPageOffsetByIndex(index = 0) {
        const {pageOffsets, maxScroll} = this.pagedMetrics;
        const safeIndex = Math.max(0, Math.min(pageOffsets.length - 1, index));
        const offset = (pageOffsets[safeIndex] !== undefined ? pageOffsets[safeIndex] : 0);
        return Math.max(0, Math.min(maxScroll, offset));
    }

    syncPagedProgress(save = false) {
        if (!this.isPagedMode)
            return;

        const safeIndex = Math.max(0, Math.min(this.totalPages - 1, this.currentPageIndex));
        const currentPage = this.pagedPages[safeIndex] || null;
        const sectionId = String((currentPage && currentPage.sectionId) || '').trim()
            || (this.contents[0] ? this.contents[0].id : '');
        const percent = (this.totalPages > 1 ? safeIndex / (this.totalPages - 1) : 0);

        this.currentPageIndex = safeIndex;
        this.currentSectionId = sectionId;
        this.progress = Object.assign({}, this.progress, {
            percent,
            sectionId,
        });

        if (save)
            this.saveProgressDebounced();
    }

    setCurrentPagedPage(index = 0, save = false) {
        if (!this.isPagedMode)
            return;

        const nextIndex = Math.max(0, Math.min(this.totalPages - 1, Math.round(index)));
        this.pageTurnDirection = (nextIndex < this.currentPageIndex ? -1 : 1);
        this.currentPageIndex = nextIndex;
        this.syncPagedProgress(save);
    }

    getPageIndexForSection(sectionId = '') {
        const safeId = String(sectionId || '').trim();
        if (!safeId)
            return -1;

        const directIndex = this.pagedPages.findIndex((page) => String(page.sectionId || '').trim() === safeId);
        if (directIndex >= 0)
            return directIndex;

        const sectionIndex = this.contents.findIndex((item) => item.id === safeId);
        if (sectionIndex < 0)
            return -1;

        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const pageSectionId = String((this.pagedPages[index] || {}).sectionId || '').trim();
            const pageSectionIndex = this.contents.findIndex((item) => item.id === pageSectionId);
            if (pageSectionIndex >= sectionIndex)
                return index;
        }

        return -1;
    }

    scheduleSnapToNearestPage() {
        if (!this.isPagedMode)
            return;
        this.clearSnapTimer();
        this.snapTimer = setTimeout(() => {
            this.snapTimer = null;
            this.snapToNearestPage();
        }, 140);
    }

    getPagedScroll() {
        if (!this.isPagedMode)
            return 0;

        return this.currentPagedPageIndex;
    }

    setPagedScroll(value = 0) {
        this.setCurrentPagedPage(value, false);
    }

    scrollToPagedOffset(value = 0, behavior = 'auto') {
        const nextIndex = Math.round(Number(value || 0) || 0);
        if (behavior === 'smooth') {
            this.pageTurnAnimating = true;
            clearTimeout(this.pageTurnTimer);
            this.pageTurnTimer = setTimeout(() => {
                this.pageTurnAnimating = false;
            }, 220);
        }
        this.setCurrentPagedPage(nextIndex, true);
    }

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (this.$refs.page && this.$refs.page.requestFullscreen) {
                await this.$refs.page.requestFullscreen();
            }
        } catch(e) {
            // ignore browser-specific fullscreen failures
        }
    }

    normalizeBinaryType(type = '') {
        let result = String(type || '').trim().toLowerCase();
        if (result === 'image/jpg' || result === 'application/octet-stream')
            result = 'image/jpeg';
        return result;
    }

    sanitizeContents(list = []) {
        return (Array.isArray(list) ? list : [])
            .map((item, index) => ({
                id: `section-${index + 1}`,
                title: String(item && item.title ? item.title : '').trim(),
            }))
            .filter((item) => item.title);
    }

    escapeCssId(id = '') {
        const value = String(id || '');
        if (typeof(CSS) !== 'undefined' && CSS.escape)
            return CSS.escape(value);
        return value.replace(/([ #;?%&,.+*~\\':"!^$[\]()=>|/@])/g, '\\$1');
    }

    wrapPagedMeasureHtml(parts = []) {
        return parts.join('');
    }

    splitOversizedUnit(unit = {}) {
        const html = String(unit.html || '').trim();
        if (!html || typeof(document) === 'undefined')
            return [];

        const host = document.createElement('div');
        host.innerHTML = html;

        if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== Node.ELEMENT_NODE)
            return [];

        const root = host.firstChild;
        const childNodes = Array.from(root.childNodes || []).filter((child) => (
            child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
        ));

        if (childNodes.length <= 1)
            return [];

        let first = true;
        return childNodes.map((child) => {
            let childHtml = '';
            if (child.nodeType === Node.TEXT_NODE) {
                childHtml = `<p class="reader-paragraph">${this.escapeHtml(String(child.textContent || '').trim())}</p>`;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                childHtml = child.outerHTML;
            }

            const childSectionId = (child.nodeType === Node.ELEMENT_NODE
                ? (child.id || ((child.querySelector && child.querySelector('[id]')) || {}).id || '')
                : '');

            const result = {
                html: childHtml,
                breakBefore: (first ? !!unit.breakBefore : false),
                sectionId: (childSectionId || (first ? String(unit.sectionId || '').trim() : '')),
            };
            first = false;
            return result;
        }).filter((item) => String(item.html || '').trim());
    }

    buildPagedUnits() {
        const units = [];
        const pushUnit = (html = '', opts = {}) => {
            if (!String(html || '').trim())
                return;
            units.push({
                html,
                breakBefore: !!opts.breakBefore,
                sectionId: String(opts.sectionId || '').trim(),
            });
        };

        if (this.coverSrc)
            pushUnit(`<div class="reader-cover-box"><img src="${this.coverSrc}" class="reader-cover" alt="${this.escapeHtml(this.title)}"></div>`);
        if (this.seriesLine)
            pushUnit(`<div class="reader-series">${this.escapeHtml(this.seriesLine)}</div>`);
        if (this.title)
            pushUnit(`<h1 class="reader-heading">${this.escapeHtml(this.title)}</h1>`);
        if (this.authorLine)
            pushUnit(`<div class="reader-subheading">${this.escapeHtml(this.authorLine)}</div>`);

        const root = document.createElement('div');
        root.innerHTML = this.readerHtml || '';

        const flattenNode = (node, sectionBreak = false) => {
            if (!node)
                return;

            if (node.nodeType === Node.TEXT_NODE) {
                const text = String(node.textContent || '').trim();
                if (text)
                    pushUnit(`<p class="reader-paragraph">${this.escapeHtml(text)}</p>`, {breakBefore: sectionBreak});
                return;
            }

            if (node.nodeType !== Node.ELEMENT_NODE)
                return;

            const element = node;
            if (element.classList.contains('reader-section-block')) {
                const children = Array.from(element.childNodes).filter((child) => (
                    child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
                ));
                if (!children.length) {
                    pushUnit(element.outerHTML, {
                        breakBefore: sectionBreak,
                        sectionId: (element.querySelector('[id]') || {}).id || '',
                    });
                    return;
                }

                let first = true;
                for (const child of children) {
                    const sectionId = (child.nodeType === Node.ELEMENT_NODE
                        ? (child.id || ((child.querySelector && child.querySelector('[id]')) || {}).id || '')
                        : '');
                    flattenNode(child, (sectionBreak && first));
                    if (sectionId && units.length) {
                        units[units.length - 1].sectionId = sectionId;
                        units[units.length - 1].breakBefore = units[units.length - 1].breakBefore || (sectionBreak && first);
                    }
                    first = false;
                }
                return;
            }

            const sectionId = element.id || ((element.querySelector && element.querySelector('[id]')) || {}).id || '';
            pushUnit(element.outerHTML, {breakBefore: sectionBreak, sectionId});
        };

        for (const node of Array.from(root.childNodes)) {
            const isSection = (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('reader-section-block'));
            flattenNode(node, isSection);
        }

        return units;
    }

    buildPagedPages() {
        if (!this.isPagedMode) {
            this.pagedPages = [];
            return;
        }

        const measureHost = this.$refs ? this.$refs.pageMeasure : null;
        if (!measureHost)
            return;

        const measureHtml = measureHost.querySelector('.reader-html');
        if (!measureHtml)
            return;

        const queue = this.buildPagedUnits().slice();
        const pages = [];
        let currentUnits = [];
        let activeSectionId = '';
        let currentPageSectionId = '';

        const applyUnits = (list) => {
            measureHtml.innerHTML = this.wrapPagedMeasureHtml(list);
        };
        const finalizePage = () => {
            if (!currentUnits.length)
                return;
            pages.push({
                html: this.wrapPagedMeasureHtml(currentUnits),
                sectionId: currentPageSectionId || activeSectionId || '',
            });
            currentUnits = [];
            currentPageSectionId = activeSectionId || '';
            applyUnits([]);
        };

        applyUnits([]);
        for (let index = 0; index < queue.length; index += 1) {
            const unit = queue[index];
            if (unit.sectionId)
                activeSectionId = unit.sectionId;
            if (unit.breakBefore && currentUnits.length) {
                finalizePage();
                currentPageSectionId = unit.sectionId || activeSectionId || '';
            }

            const candidateUnits = currentUnits.concat(unit.html);
            applyUnits(candidateUnits);
            if (this.doesPagedMeasureOverflow(measureHost) && !currentUnits.length) {
                const splitUnits = this.splitOversizedUnit(unit);
                if (splitUnits.length) {
                    queue.splice(index, 1, ...splitUnits);
                    index -= 1;
                    applyUnits([]);
                    continue;
                }
            }

            if (this.doesPagedMeasureOverflow(measureHost) && currentUnits.length) {
                finalizePage();
                currentPageSectionId = unit.sectionId || activeSectionId || '';
                currentUnits = [unit.html];
                applyUnits(currentUnits);
                if (this.doesPagedMeasureOverflow(measureHost)) {
                    const splitUnits = this.splitOversizedUnit(unit);
                    if (splitUnits.length) {
                        currentUnits = [];
                        applyUnits([]);
                        queue.splice(index, 1, ...splitUnits);
                        index -= 1;
                        continue;
                    }
                }
            } else {
                currentUnits = candidateUnits;
                if (unit.sectionId && !currentPageSectionId)
                    currentPageSectionId = unit.sectionId;
            }
        }

        finalizePage();
        this.pagedPages = (pages.length ? pages : [{html: this.readerHtml || '', sectionId: ''}]);
        this.currentPageIndex = Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex));
    }

    extractImageMap(parser) {
        const result = new Map();
        for (const node of parser.$$array('/binary')) {
            const attrs = (node.attrs() || {});
            const id = attrs.id;
            const contentType = this.normalizeBinaryType(attrs['content-type']);
            const base64 = node.text();
            if (!id || !base64 || !contentType.startsWith('image/'))
                continue;

            result.set(String(id), `data:${contentType};base64,${base64}`);
        }
        return result;
    }

    escapeHtml(value = '') {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    resolveImageSrc(attrs = {}, imageMap) {
        const href = attrs.href || attrs['l:href'] || attrs['xlink:href'] || '';
        const id = String(href || '').replace(/^#/, '').trim();
        if (!id)
            return '';

        return imageMap.get(id) || '';
    }

    renderInlineNodes(nodes = [], imageMap) {
        const parts = [];

        for (const raw of nodes) {
            const type = raw && raw[0];
            if (type === 2 || type === 3) {
                parts.push(this.escapeHtml(raw[1] || ''));
                continue;
            }

            if (type !== 1)
                continue;

            const name = String(raw[1] || '').toLowerCase();
            const attrs = Object.fromEntries(raw[2] || []);
            const children = raw[3] || [];

            if (name === 'strong') {
                parts.push(`<strong>${this.renderInlineNodes(children, imageMap)}</strong>`);
            } else if (name === 'emphasis') {
                parts.push(`<em>${this.renderInlineNodes(children, imageMap)}</em>`);
            } else if (name === 'style') {
                parts.push(`<span>${this.renderInlineNodes(children, imageMap)}</span>`);
            } else if (name === 'a') {
                parts.push(`<span class="reader-inline-link">${this.renderInlineNodes(children, imageMap)}</span>`);
            } else if (name === 'image') {
                const src = this.resolveImageSrc(attrs, imageMap);
                if (src)
                    parts.push(`<img src="${src}" class="reader-inline-image" alt="fb2-image">`);
            } else if (name === 'empty-line') {
                parts.push('<br>');
            } else {
                parts.push(this.renderInlineNodes(children, imageMap));
            }
        }

        return parts.join('');
    }

    renderTitleNode(raw, imageMap, context = {}) {
        const children = raw[3] || [];
        const lines = [];

        for (const child of children) {
            if (child && child[0] === 1 && String(child[1] || '').toLowerCase() === 'p') {
                const html = this.renderInlineNodes(child[3] || [], imageMap).trim();
                if (html)
                    lines.push(html);
            } else {
                const html = this.renderInlineNodes([child], imageMap).trim();
                if (html)
                    lines.push(html);
            }
        }

        const titleHtml = lines.join('<br>');
        if (!titleHtml)
            return '';

        if (context.sectionTitle) {
            const state = (context.state || {sectionIndex: 0});
            const item = this.contents[state.sectionIndex] || null;
            if (item)
                state.sectionIndex++;

            const idAttr = (item ? ` id="${item.id}"` : '');
            const level = Math.min(4, 2 + Math.max(0, context.depth || 0));
            return `<h${level}${idAttr} class="reader-anchored-heading reader-section-heading">${titleHtml}</h${level}>`;
        }

        return `<div class="reader-opening-title">${titleHtml}</div>`;
    }

    renderBlockNodes(nodes = [], imageMap, context = {}) {
        const parts = [];

        for (const raw of nodes) {
            const type = raw && raw[0];
            if (type === 2 || type === 3) {
                const text = this.escapeHtml(raw[1] || '').trim();
                if (text)
                    parts.push(`<p class="reader-paragraph">${text}</p>`);
                continue;
            }

            if (type !== 1)
                continue;

            const name = String(raw[1] || '').toLowerCase();
            const attrs = Object.fromEntries(raw[2] || []);
            const children = raw[3] || [];

            if (name === 'section') {
                parts.push(`<section class="reader-section-block">${this.renderBlockNodes(children, imageMap, {
                    state: context.state,
                    depth: (context.depth || 0) + 1,
                    inSection: true,
                })}</section>`);
            } else if (name === 'title') {
                parts.push(this.renderTitleNode(raw, imageMap, {
                    state: context.state,
                    depth: Math.max(0, (context.depth || 0) - 1),
                    sectionTitle: !!context.inSection,
                }));
            } else if (name === 'p') {
                parts.push(`<p class="reader-paragraph">${this.renderInlineNodes(children, imageMap)}</p>`);
            } else if (name === 'subtitle') {
                parts.push(`<h4 class="reader-subtitle">${this.renderInlineNodes(children, imageMap)}</h4>`);
            } else if (name === 'epigraph') {
                parts.push(`<blockquote class="reader-epigraph">${this.renderBlockNodes(children, imageMap, {
                    state: context.state,
                    depth: context.depth || 0,
                    inSection: false,
                })}</blockquote>`);
            } else if (name === 'text-author') {
                parts.push(`<div class="reader-epigraph-author">${this.renderInlineNodes(children, imageMap)}</div>`);
            } else if (name === 'poem') {
                parts.push(`<div class="reader-poem">${this.renderBlockNodes(children, imageMap, context)}</div>`);
            } else if (name === 'stanza') {
                parts.push(`<div class="reader-stanza">${this.renderBlockNodes(children, imageMap, context)}</div>`);
            } else if (name === 'cite') {
                parts.push(`<blockquote class="reader-cite">${this.renderBlockNodes(children, imageMap, context)}</blockquote>`);
            } else if (name === 'image') {
                const src = this.resolveImageSrc(attrs, imageMap);
                if (src)
                    parts.push(`<div class="reader-image-block"><img src="${src}" class="reader-inline-image" alt="fb2-image"></div>`);
            } else if (name === 'empty-line') {
                parts.push('<div class="reader-empty-line"></div>');
            } else {
                const fallback = this.renderBlockNodes(children, imageMap, context);
                if (fallback)
                    parts.push(fallback);
            }
        }

        return parts.join('');
    }

    buildReaderHtml(parser) {
        const parts = [];
        const imageMap = this.extractImageMap(parser);
        const context = {state: {sectionIndex: 0}, depth: 0, inSection: false};

        for (const body of parser.$$array('/body')) {
            const attrs = (body.attrs() || {});
            const bodyName = String(attrs.name || '').toLowerCase();
            const bodyNode = body.rawNodes[0] || null;
            const html = this.renderBlockNodes((bodyNode && bodyNode[3]) || [], imageMap, context);

            if (bodyName === 'notes')
                parts.push(`<section class="reader-notes"><h2>РџСЂРёРјРµС‡Р°РЅРёСЏ</h2>${html}</section>`);
            else
                parts.push(`<section class="reader-section">${html}</section>`);
        }

        return parts.join('\n');
    }

    async loadReader() {
        if (!this.bookUid) {
            this.loading = false;
            this.readerHtml = '';
            this.contents = [];
            this.error = 'РљРЅРёРіР° РґР»СЏ С‡С‚РµРЅРёСЏ РЅРµ РІС‹Р±СЂР°РЅР°. РћС‚РєСЂРѕР№С‚Рµ С‡РёС‚Р°Р»РєСѓ РёР· РєР°СЂС‚РѕС‡РєРё РєРЅРёРіРё.';
            return;
        }

        const api = this.$root.api;
        if (!api) {
            this.error = 'Р§РёС‚Р°Р»РєР° РµС‰С‘ РЅРµ РіРѕС‚РѕРІР°. РџРѕРїСЂРѕР±СѓР№С‚Рµ РѕС‚РєСЂС‹С‚СЊ РєРЅРёРіСѓ РµС‰С‘ СЂР°Р·.';
            return;
        }

        this.loading = true;
        this.error = '';
        this.readerHtml = '';
        this.contents = [];
        this.bookmarks = [];
        this.currentPlacesTab = 'progress';
        this.currentSectionId = '';
        this.restorePending = false;
        this.controlsOpen = false;
        this.contentsDialogOpen = false;
        this.bookmarksDialogOpen = false;
        this.bookmarkComposerOpen = false;
        this.inlineContentsVisible = false;
        this.chromeHidden = false;
        this.readerMetaExpanded = false;

        try {
            const bookResponse = await api.getBookInfo(this.bookUid);
            let stateResponse = {preferences: {}, progress: {}};
            try {
                stateResponse = await api.getReaderState(this.bookUid);
            } catch(e) {
                stateResponse = {preferences: {}, progress: {}};
            }

            this.bookInfo = (bookResponse ? bookResponse.bookInfo : null);
            const info = (this.bookInfo || {});
            const book = (info.book || {});
            if (!info.fb2)
                throw new Error('Р’СЃС‚СЂРѕРµРЅРЅР°СЏ С‡РёС‚Р°Р»РєР° РїРѕРєР° РїРѕРґРґРµСЂР¶РёРІР°РµС‚ С‚РѕР»СЊРєРѕ FB2.');

            const parser = new Fb2Parser(info.fb2);
            const fb2Info = parser.bookInfo();
            this.title = book.title || (fb2Info.titleInfo && fb2Info.titleInfo.bookTitle) || 'Р‘РµР· РЅР°Р·РІР°РЅРёСЏ';
            this.authorLine = book.author || ((fb2Info.titleInfo && fb2Info.titleInfo.author) ? fb2Info.titleInfo.author.join(', ') : '');
            this.seriesLine = (book.series ? `${book.series}${book.serno ? ` #${book.serno}` : ''}` : '');
            this.coverSrc = info.cover || '';
            this.contents = this.sanitizeContents(info.contents || []);
            this.readerHtml = this.buildReaderHtml(parser);

            this.preferences = Object.assign({}, this.preferences, stateResponse.preferences || {});
            this.progress = Object.assign({percent: 0, sectionId: '', updatedAt: ''}, stateResponse.progress || {});
            this.bookmarks = Array.isArray(stateResponse.bookmarks) ? stateResponse.bookmarks : [];
            this.currentSectionId = String(this.progress.sectionId || '').trim();
            this.restorePending = true;
            this.currentPageIndex = 0;

            this.$root.setAppTitle(this.title);
            this.$nextTick(() => {
                this.attachScrollerObserver();
                this.updateScrollerViewport();
                requestAnimationFrame(() => {
                    this.updateScrollerViewport();
                    this.restoreProgress();
                });
            });
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
        }
    }

    restoreProgress() {
        if (!this.restorePending || !this.$refs.scroller)
            return;

        this.restorePending = false;
        const scroller = this.$refs.scroller;

        if (this.progress.sectionId) {
            if (this.isPagedMode) {
                const pageIndex = this.getPageIndexForSection(this.progress.sectionId);
                if (pageIndex >= 0) {
                    this.setCurrentPagedPage(pageIndex, false);
                    return;
                }
            }

            const target = scroller.querySelector(`#${this.escapeCssId(this.progress.sectionId)}`);
            if (target) {
                if (this.isPagedMode)
                    this.setPagedScroll(this.getPagedOffset(target));
                else
                    scroller.scrollTop = Math.max(0, target.offsetTop - 18);
                this.updateCurrentSectionFromScroll();
                return;
            }
        }

        if (this.isPagedMode) {
            const pageIndex = Math.round((this.totalPages - 1) * (Number(this.progress.percent || 0) || 0));
            this.setCurrentPagedPage(pageIndex, false);
        } else {
            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            scroller.scrollTop = maxScroll * (Number(this.progress.percent || 0) || 0);
            this.updateCurrentSectionFromScroll();
        }
    }

    getPagedOffset(target) {
        if (!this.$refs.scroller || !target)
            return 0;

        const scroller = this.$refs.scroller;
        const scrollerRect = scroller.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const rawOffset = Math.max(0, (
            this.isHorizontalPaged
                ? scroller.scrollLeft + (targetRect.left - scrollerRect.left)
                : scroller.scrollTop + (targetRect.top - scrollerRect.top)
        ));
        const {pageOffsets, maxScroll} = this.pagedMetrics;
        const pageIndex = Math.max(0, Math.floor(rawOffset / Math.max(1, this.pagedMetrics.pageSize)));
        const snappedOffset = (pageOffsets[pageIndex] !== undefined ? pageOffsets[pageIndex] : 0);

        return Math.max(0, Math.min(maxScroll, snappedOffset));
    }

    updateCurrentSectionFromScroll() {
        if (!this.$refs.scroller || !this.contents.length)
            return;

        if (this.isPagedMode) {
            const currentPage = this.pagedPages[this.currentPagedPageIndex] || null;
            const activeId = String((currentPage && currentPage.sectionId) || '').trim();
            this.currentSectionId = activeId || (this.contents[0] ? this.contents[0].id : '');
            return;
        }

        const scroller = this.$refs.scroller;
        let activeId = this.currentSectionId;
        for (const item of this.contents) {
            const target = scroller.querySelector(`#${this.escapeCssId(item.id)}`);
            if (!target)
                continue;

            if (target.offsetTop - scroller.scrollTop <= 80) {
                activeId = item.id;
            } else {
                break;
            }
        }

        this.currentSectionId = activeId || (this.contents[0] ? this.contents[0].id : '');
    }

    onScroll() {
        if (this.loading || !this.$refs.scroller)
            return;

        if (this.isPagedMode)
            return;

        const scroller = this.$refs.scroller;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const currentScroll = scroller.scrollTop;
        const percent = (maxScroll > 0 ? currentScroll / maxScroll : 0);
        this.updateCurrentSectionFromScroll();
        this.progress = Object.assign({}, this.progress, {
            percent,
            sectionId: this.currentSectionId || '',
        });
        this.saveProgressDebounced();
    }

    handleReaderTap(event) {
        if (!this.$refs.scroller)
            return;

        const target = event.target;
        if (target && target.closest && target.closest('button, a, img, input, textarea, select, .q-btn, .reader-dialog'))
            return;

        const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
        if (selection)
            return;

        const rect = this.$refs.scroller.getBoundingClientRect();
        const relX = (event.clientX - rect.left) / rect.width;
        const relY = (event.clientY - rect.top) / rect.height;
        if (this.isPagedMode && this.activePreferences.pagedNavigation === 'tap') {
            if (this.isHorizontalPaged) {
                if (relX <= 0.22) {
                    this.goToRelativePage(-1);
                    return;
                }
                if (relX >= 0.78) {
                    this.goToRelativePage(1);
                    return;
                }
            } else {
                if (relY <= 0.22) {
                    this.goToRelativePage(-1);
                    return;
                }
                if (relY >= 0.78) {
                    this.goToRelativePage(1);
                    return;
                }
            }
        }
        const isCenterTap = (relX >= 0.18 && relX <= 0.82 && relY >= 0.18 && relY <= 0.82);
        if (!isCenterTap)
            return;

        this.chromeHidden = !this.chromeHidden;
        if (this.chromeHidden) {
            this.controlsOpen = false;
            this.contentsDialogOpen = false;
        }
    }

    handleReaderWheel(event) {
        if (!this.isPagedMode || this.activePreferences.pagedNavigation !== 'wheel' || !this.$refs.scroller || !event)
            return;

        const delta = (this.isHorizontalPaged ? (Number(event.deltaX || 0) || Number(event.deltaY || 0)) : Number(event.deltaY || 0));
        if (Math.abs(delta) < 8)
            return;

        event.preventDefault();
        this.goToRelativePage(delta > 0 ? 1 : -1);
    }

    handleReaderTouchStart(event) {
        if (!this.isPagedMode || !event || !event.touches || event.touches.length !== 1)
            return;

        const touch = event.touches[0];
        this.touchStartPoint = {
            x: Number(touch.clientX || 0) || 0,
            y: Number(touch.clientY || 0) || 0,
        };
    }

    handleReaderTouchEnd(event) {
        if (!this.isPagedMode || !this.touchStartPoint || !event || !event.changedTouches || !event.changedTouches.length)
            return;

        const touch = event.changedTouches[0];
        const deltaX = (Number(touch.clientX || 0) || 0) - this.touchStartPoint.x;
        const deltaY = (Number(touch.clientY || 0) || 0) - this.touchStartPoint.y;
        this.touchStartPoint = null;

        const threshold = 36;
        if (this.isHorizontalPaged) {
            if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY))
                return;
            this.goToRelativePage(deltaX < 0 ? 1 : -1);
            return;
        }

        if (Math.abs(deltaY) < threshold || Math.abs(deltaY) <= Math.abs(deltaX))
            return;
        this.goToRelativePage(deltaY < 0 ? 1 : -1);
    }

    handleReaderTouchCancel() {
        this.touchStartPoint = null;
    }

    jumpToContent(id = '') {
        this.contentsDialogOpen = false;
        this.chromeHidden = false;
        if (!id)
            return;

        this.$nextTick(() => {
            this.currentSectionId = id;
            if (this.isPagedMode) {
                const pageIndex = this.getPageIndexForSection(id);
                this.setCurrentPagedPage((pageIndex >= 0 ? pageIndex : 0), true);
                return;
            }

            if (!this.$refs.scroller)
                return;

            const scroller = this.$refs.scroller;
            const target = scroller.querySelector(`#${this.escapeCssId(id)}`);
            if (!target)
                return;

            const top = Math.max(0, target.offsetTop - 18);
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    jumpToAdjacentSection(delta = 0) {
        const index = this.currentSectionIndex;
        if (index < 0)
            return;

        const next = this.contents[index + delta];
        if (next)
            this.jumpToContent(next.id);
    }

    goToRelativePage(delta = 0) {
        if (!this.$refs.scroller)
            return;

        const scroller = this.$refs.scroller;
        if (this.isPagedMode) {
            const nextIndex = this.currentPagedPageIndex + delta;
            this.setCurrentPagedPage(nextIndex, true);
            return;
        }

        const pageHeight = Math.max(1, scroller.clientHeight);
        const nextTop = Math.max(0, Math.min(
            scroller.scrollHeight - scroller.clientHeight,
            scroller.scrollTop + delta * pageHeight,
        ));
        scroller.scrollTo({top: nextTop, behavior: 'smooth'});
    }

    snapToNearestPage() {
        if (!this.isPagedMode)
            return;
        this.setCurrentPagedPage(this.currentPagedPageIndex, false);
    }

    async addCurrentBookmark() {
        const selection = (window.getSelection ? window.getSelection().toString().trim() : '');
        if (selection) {
            this.bookmarkDraft = {
                title: this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
                excerpt: selection,
                note: '',
                percent: Number(this.progress.percent || 0) || 0,
                sectionId: this.currentSectionId || '',
            };
            this.bookmarkComposerOpen = true;
            return;
        }

        await this.saveBookmark({
            title: this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
            excerpt: '',
            note: '',
            percent: Number(this.progress.percent || 0) || 0,
            sectionId: this.currentSectionId || '',
        });
    }

    async saveBookmark(bookmark = {}, successText = this.uiText.bookmarkAdded) {
        const api = this.$root.api;
        if (!api || !this.bookUid)
            return;

        try {
            const response = await api.addReaderBookmark(this.bookUid, bookmark);
            this.bookmarks = Array.isArray(response.bookmarks) ? response.bookmarks : this.bookmarks;
            this.currentPlacesTab = (String(bookmark.note || '').trim() ? 'notes' : 'bookmarks');
            this.$root.notify.success(successText, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.error);
        }
    }

    async saveBookmarkDraft(mode = 'bookmark') {
        const note = (mode === 'note' ? String(this.bookmarkDraft.note || '').trim() : '');
        await this.saveBookmark({
            title: this.bookmarkDraft.title || this.currentSectionTitle || this.title || this.uiText.bookmarkTitle,
            excerpt: this.bookmarkDraft.excerpt || '',
            note,
            percent: Number(this.bookmarkDraft.percent || 0) || 0,
            sectionId: this.bookmarkDraft.sectionId || '',
        }, mode === 'note' ? this.uiText.noteSaved : this.uiText.bookmarkAdded);
        this.bookmarkComposerOpen = false;
        this.bookmarkDraft = {
            title: '',
            excerpt: '',
            note: '',
            percent: 0,
            sectionId: '',
        };
        this.openPlacesDialog(mode === 'note' ? 'notes' : 'bookmarks');
    }

    async removeBookmark(bookmarkId = '') {
        const api = this.$root.api;
        if (!api || !this.bookUid || !bookmarkId)
            return;

        try {
            const response = await api.deleteReaderBookmark(this.bookUid, bookmarkId);
            this.bookmarks = Array.isArray(response.bookmarks) ? response.bookmarks : [];
        } catch (e) {
            this.$root.stdDialog.alert(e.message, 'РћС€РёР±РєР°');
        }
    }

    jumpToBookmark(bookmark = {}) {
        this.bookmarksDialogOpen = false;
        this.chromeHidden = false;
        if (!this.$refs.scroller)
            return;

        this.$nextTick(() => {
            const scroller = this.$refs.scroller;
            const percent = Math.max(0, Math.min(1, Number(bookmark.percent || 0) || 0));

            if (percent > 0) {
                if (this.isPagedMode) {
                    this.setCurrentPagedPage(Math.round((this.totalPages - 1) * percent), true);
                    return;
                }

                const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
                const top = maxScroll * percent;
                scroller.scrollTo({top, behavior: 'smooth'});
                return;
            }

            const sectionId = String(bookmark.sectionId || '').trim();
            if (sectionId) {
                this.jumpToContent(sectionId);
                return;
            }

            if (this.isPagedMode) {
                this.setCurrentPagedPage(Math.round((this.totalPages - 1) * percent), true);
                return;
            }

            const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
            const top = maxScroll * percent;
            scroller.scrollTo({top, behavior: 'smooth'});
        });
    }

    jumpToProgress() {
        this.bookmarksDialogOpen = false;
        this.restorePending = true;
        this.$nextTick(() => {
            requestAnimationFrame(() => this.restoreProgress());
        });
    }

    formatBookmarkDate(value = '') {
        const date = new Date(value);
        if (Number.isNaN(date.getTime()))
            return '';
        return date.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    async persistProgress() {
        if (!this.bookUid)
            return;
        const api = this.$root.api;
        if (!api)
            return;

        await api.updateReaderProgress(this.bookUid, {
            percent: Number(this.progress.percent || 0) || 0,
            sectionId: this.currentSectionId || '',
        });
    }

    async persistPreferences() {
        const api = this.$root.api;
        if (!api)
            return;

        await api.updateReaderPreferences(this.preferences);
    }

    flushProgress() {
        if (this.saveProgressDebounced && this.saveProgressDebounced.flush)
            this.saveProgressDebounced.flush();
    }

    setTheme(theme) {
        this.preferences = Object.assign({}, this.preferences, {theme});
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    changeFontSize(delta) {
        this.updateActivePreferences({
            fontSize: Math.max(14, Math.min(30, this.activePreferences.fontSize + delta)),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    changeContentWidth(delta) {
        this.updateActivePreferences({
            contentWidth: Math.max(560, Math.min(1200, this.activePreferences.contentWidth + delta)),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    changeLineHeight(delta) {
        const next = Math.round((this.activePreferences.lineHeight + delta) * 100) / 100;
        this.updateActivePreferences({
            lineHeight: Math.max(1.35, Math.min(2.2, next)),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }
}

export default vueComponent(Reader);
</script>

<style scoped>
.reader-page {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 100%;
    overflow: hidden;
    background: var(--reader-bg);
    color: var(--reader-text);
}

.reader-page--immersive {
    cursor: default;
}

.reader-toolbar {
    position: sticky;
    top: 0;
    z-index: 12;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface) 92%, transparent);
    backdrop-filter: blur(10px);
}

.reader-toolbar-main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.reader-book-meta {
    min-width: 0;
}

.reader-book-title {
    font-size: 18px;
    font-weight: 750;
    line-height: 1.2;
}

.reader-book-author {
    margin-top: 2px;
    color: var(--reader-muted);
    font-size: 13px;
}

.reader-book-progress {
    margin-top: 6px;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
}

.reader-book-progress.is-clickable {
    cursor: pointer;
    transition: color 0.18s ease;
}

.reader-book-progress.is-clickable:hover {
    color: var(--reader-accent);
}

.reader-toolbar-quick-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
}

.reader-icon-btn {
    border: 1px solid var(--reader-border);
    background: var(--reader-surface-2);
}

.reader-icon-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-toolbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.reader-theme-switch,
.reader-stepper {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
}

.reader-theme-switch :deep(.q-btn.is-active) {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-stepper-value,
.reader-progress-text {
    min-width: 54px;
    text-align: center;
    font-size: 13px;
    font-weight: 700;
    color: var(--reader-muted);
}

.reader-loading,
.reader-error {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.reader-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}

.reader-scroll--paged {
    scroll-behavior: smooth;
    overscroll-behavior: contain;
}

.reader-scroll--paged-vertical {
    overflow-y: hidden;
    overflow-x: hidden;
    scroll-snap-type: y mandatory;
    touch-action: none;
}

.reader-scroll--paged-horizontal {
    overflow-x: hidden;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 0;
    touch-action: none;
}

.reader-shell {
    padding: 28px 18px 72px;
}

.reader-shell--paged-horizontal {
    display: flex;
    justify-content: flex-start;
    align-items: flex-start;
    width: max-content;
    min-width: 100%;
    padding-inline: 0;
    box-sizing: border-box;
}

.reader-cover-box {
    display: flex;
    justify-content: center;
    margin-bottom: 24px;
}

.reader-cover {
    width: 180px;
    max-width: 42vw;
    border-radius: 14px;
    box-shadow: 0 18px 38px rgba(0, 0, 0, 0.18);
}

.reader-body {
    width: min(100%, var(--reader-content-width));
    margin: 0 auto;
    font-size: var(--reader-font-size);
    line-height: var(--reader-line-height);
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes {
    min-height: auto;
    padding-bottom: 0;
}

.reader-body--paged {
    width: 100%;
    max-width: none;
    min-height: auto;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
}

.reader-body--paged .reader-html {
    height: auto;
}

.reader-pages {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--reader-page-gap);
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    min-height: var(--reader-page-min-height);
}

.reader-pages--horizontal {
    flex-direction: row;
    gap: 0;
    align-items: center;
    justify-content: center;
}

.reader-page-sheet {
    width: min(100%, var(--reader-page-frame-width));
    max-width: var(--reader-page-frame-width);
    min-height: var(--reader-page-min-height);
    height: var(--reader-page-min-height);
    padding: var(--reader-page-padding);
    box-sizing: border-box;
    border: 1px solid var(--reader-border);
    border-radius: 26px;
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    box-shadow: 0 18px 42px rgba(0, 0, 0, 0.14);
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow: hidden;
}

.reader-page-sheet--horizontal {
    flex: 0 0 var(--reader-page-frame-width);
    width: var(--reader-page-frame-width);
    max-width: var(--reader-page-frame-width);
    min-height: var(--reader-page-min-height);
    height: var(--reader-page-min-height);
}

.reader-page-sheet--measure {
    position: fixed;
    left: -20000px;
    top: 0;
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
}

.reader-page-slide-x-forward-enter-active,
.reader-page-slide-x-forward-leave-active,
.reader-page-slide-x-back-enter-active,
.reader-page-slide-x-back-leave-active,
.reader-page-slide-y-forward-enter-active,
.reader-page-slide-y-forward-leave-active,
.reader-page-slide-y-back-enter-active,
.reader-page-slide-y-back-leave-active {
    transition: opacity 0.28s ease, transform 0.28s cubic-bezier(.22, .8, .3, 1);
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-x-back-enter-from,
.reader-page-slide-y-forward-enter-from,
.reader-page-slide-y-back-enter-from {
    opacity: 0;
}

.reader-page-slide-x-forward-leave-active,
.reader-page-slide-x-back-leave-active,
.reader-page-slide-y-forward-leave-active,
.reader-page-slide-y-back-leave-active {
    position: absolute;
    inset: 0;
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-x-back-leave-to {
    transform: translateX(42px) scale(0.992);
}

.reader-page-slide-x-forward-leave-to,
.reader-page-slide-x-back-enter-from {
    transform: translateX(-42px) scale(0.992);
}

.reader-page-slide-y-forward-enter-from,
.reader-page-slide-y-back-leave-to {
    transform: translateY(26px) scale(0.996);
}

.reader-page-slide-y-forward-leave-to,
.reader-page-slide-y-back-enter-from {
    transform: translateY(-26px) scale(0.996);
}

.reader-page-slide-x-forward-leave-to,
.reader-page-slide-x-back-leave-to,
.reader-page-slide-y-forward-leave-to,
.reader-page-slide-y-back-leave-to {
    opacity: 0;
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes,
.reader-body--paged .reader-progress-bar,
.reader-body--paged .reader-contents-inline,
.reader-body--paged .reader-series,
.reader-body--paged .reader-heading,
.reader-body--paged .reader-subheading {
    break-inside: avoid;
}

.reader-series {
    color: var(--reader-muted);
    font-size: 0.92em;
    font-weight: 650;
}

.reader-heading {
    margin: 10px 0 0;
    font-size: clamp(28px, 4vw, 40px);
    line-height: 1.06;
}

.reader-subheading {
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 0.98em;
}

.reader-opening-title {
    margin: 0 0 18px;
    font-size: 1.22em;
    font-weight: 700;
    line-height: 1.35;
}

.reader-html :deep(.reader-section-block) {
    margin-top: 18px;
}

.reader-body--paged .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: page;
    page-break-before: always;
}

.reader-body--paged-horizontal .reader-html :deep(.reader-section-block + .reader-section-block) {
    break-before: column;
    page-break-before: auto;
}

.reader-html :deep(.reader-section-heading) {
    margin: 1.3em 0 0.55em;
    line-height: 1.18;
}

.reader-html :deep(.reader-subtitle) {
    margin: 1em 0 0.5em;
    line-height: 1.25;
}

.reader-html :deep(.reader-epigraph),
.reader-html :deep(.reader-cite) {
    margin: 1.1em 0;
    padding: 0.4em 0 0.4em 1.1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(.reader-epigraph-author) {
    margin-top: 0.55em;
    text-align: right;
    font-size: 0.92em;
}

.reader-html :deep(.reader-poem),
.reader-html :deep(.reader-stanza) {
    margin: 1em 0;
}

.reader-html :deep(.reader-image-block) {
    margin: 1.1em 0;
    text-align: center;
}

.reader-html :deep(.reader-empty-line) {
    height: 1em;
}

.reader-contents-inline {
    margin: 22px 0 0;
    padding: 14px 16px;
    border: 1px solid var(--reader-border);
    border-radius: 18px;
    background: color-mix(in srgb, var(--reader-surface) 82%, transparent);
}

.reader-contents-inline-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.reader-contents-inline-title {
    font-size: 14px;
    font-weight: 750;
    color: var(--reader-muted);
}

.reader-contents-toggle {
    padding: 6px 10px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.reader-contents-inline-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
}

.reader-contents-chip {
    padding: 8px 12px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    cursor: pointer;
}

.reader-progress-bar {
    margin: 20px 0 28px;
    width: 100%;
    height: 6px;
    border-radius: 999px;
    background: var(--reader-surface-2);
    overflow: hidden;
}

.reader-progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--reader-accent), color-mix(in srgb, var(--reader-accent) 72%, white));
}

.reader-html {
    color: var(--reader-text);
}

.reader-html :deep(h1),
.reader-html :deep(h2),
.reader-html :deep(h3),
.reader-html :deep(h4) {
    line-height: 1.15;
    margin: 1.45em 0 0.5em;
}

.reader-html :deep(.reader-anchored-heading) {
    scroll-margin-top: 84px;
}

.reader-html :deep(p),
.reader-paragraph {
    margin: 0.8em 0;
    text-align: justify;
}

.reader-html :deep(blockquote) {
    margin: 1.2em 0;
    padding-left: 1em;
    border-left: 3px solid var(--reader-border);
    color: var(--reader-muted);
}

.reader-html :deep(img),
.reader-inline-image {
    display: block;
    max-width: min(100%, 680px);
    height: auto;
    margin: 18px auto;
    border-radius: 12px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
}

.reader-notes {
    margin-top: 2.5em;
    padding-top: 1.5em;
    border-top: 1px solid var(--reader-border);
}

.reader-mobile-footer {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface) 96%, transparent);
}

.reader-mobile-bar {
    display: flex;
    gap: 8px;
    padding: 0;
    border: 1px solid var(--reader-border);
    border-radius: 18px;
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.2);
    backdrop-filter: blur(12px);
}

.reader-mobile-btn {
    flex: 1 1 0;
    min-height: 42px;
    border: 1px solid var(--reader-border);
    border-radius: 14px;
    background: var(--reader-surface-2);
}

.reader-mobile-btn.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 6px 10px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 10px 22px rgba(0, 0, 0, 0.16);
    backdrop-filter: blur(10px);
}

.reader-dialog {
    width: min(92vw, 420px);
    max-height: 85vh;
    border-radius: 22px;
    background: var(--reader-surface) !important;
    color: var(--reader-text) !important;
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.reader-overlay-panel {
    position: absolute;
    top: 76px;
    right: 14px;
    z-index: 35;
    width: min(92vw, 420px);
    max-height: calc(100vh - 120px);
    border: 1px solid var(--reader-border);
    border-radius: 22px;
    overflow: hidden;
    background: var(--reader-surface);
    color: var(--reader-text);
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.26);
}

.reader-dialog :deep(.q-btn),
.reader-dialog :deep(.q-icon),
.reader-dialog :deep(.q-field__native),
.reader-dialog :deep(.q-field__input),
.reader-dialog :deep(.q-field__label),
.reader-dialog :deep(.q-field__marginal),
.reader-dialog :deep(.q-field__control) {
    color: var(--reader-text);
}

.reader-dialog :deep(.q-field__control) {
    background: var(--reader-surface-2);
}

.reader-dialog--contents {
    overflow: hidden;
}

.reader-dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--reader-border);
}

.reader-dialog-title {
    font-size: 18px;
    font-weight: 750;
}

.reader-dialog-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: calc(85vh - 64px);
    overflow: auto;
    padding: 12px;
}

.reader-dialog-link {
    padding: 12px 14px;
    border: 1px solid var(--reader-border);
    border-radius: 14px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    text-align: left;
    cursor: pointer;
}

.reader-dialog-link--bookmark {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 56px 36px;
    align-items: start;
    gap: 10px;
}

.reader-dialog-link-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.reader-dialog-link-subtext {
    color: var(--reader-muted);
    font-size: 11px;
    line-height: 1.35;
}

.reader-dialog-link-meta {
    min-width: 56px;
    align-self: start;
    text-align: right;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
}

.reader-bookmark-delete {
    align-self: start;
    justify-self: end;
    color: var(--reader-muted);
}

.reader-dialog-link.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-dialog-tabs {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.reader-dialog-tab {
    padding: 8px 12px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}

.reader-dialog-tab.is-active {
    background: var(--reader-accent-soft);
    color: var(--reader-accent);
}

.reader-continue-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px;
    border: 1px solid var(--reader-border);
    border-radius: 16px;
    background: var(--reader-surface-2);
}

.reader-continue-title {
    font-size: 15px;
    font-weight: 750;
}

.reader-continue-meta,
.reader-continue-updated,
.reader-dialog-empty {
    color: var(--reader-muted);
    font-size: 12px;
}

.reader-continue-actions,
.reader-compose-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reader-inline-action-btn {
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
}

.reader-compose-input :deep(.q-field__control),
.reader-compose-input :deep(.q-field__marginal),
.reader-compose-input :deep(.q-field__native),
.reader-compose-input :deep(.q-field__input) {
    color: var(--reader-text);
}

.reader-compose-input :deep(.q-field__control) {
    background: var(--reader-surface-2);
}

.reader-compose-input :deep(.q-field__label),
.reader-compose-input :deep(.q-field__bottom) {
    color: var(--reader-muted);
}

.reader-dialog-link-note {
    color: var(--reader-text);
    font-size: 12px;
    line-height: 1.45;
    font-weight: 600;
}

.reader-dialog--composer {
    width: min(92vw, 520px);
}

.reader-compose-title {
    font-size: 14px;
    font-weight: 750;
}

.reader-compose-excerpt {
    padding: 10px 12px;
    border-left: 3px solid var(--reader-border);
    background: color-mix(in srgb, var(--reader-surface-2) 86%, transparent);
    color: var(--reader-muted);
    line-height: 1.55;
}

.reader-theme-dark {
    --reader-bg: #12171b;
    --reader-surface: #182127;
    --reader-surface-2: #222c33;
    --reader-text: #edf2f5;
    --reader-muted: #9db0bc;
    --reader-border: rgba(157, 176, 188, 0.22);
    --reader-accent: #5eead4;
    --reader-accent-soft: rgba(94, 234, 212, 0.12);
}

.reader-theme-sepia {
    --reader-bg: #f4ecdd;
    --reader-surface: #fbf6ec;
    --reader-surface-2: #efe4d2;
    --reader-text: #402f20;
    --reader-muted: #7c6855;
    --reader-border: rgba(64, 47, 32, 0.16);
    --reader-accent: #b76a2c;
    --reader-accent-soft: rgba(183, 106, 44, 0.12);
}

.reader-theme-light {
    --reader-bg: #f7fafc;
    --reader-surface: #ffffff;
    --reader-surface-2: #eef3f7;
    --reader-text: #1f2a33;
    --reader-muted: #60707d;
    --reader-border: rgba(96, 112, 125, 0.18);
    --reader-accent: #0f9f8f;
    --reader-accent-soft: rgba(15, 159, 143, 0.12);
}

.reader-theme-eink {
    --reader-bg: var(--reader-eink-bg, #f3f3ee);
    --reader-surface: var(--reader-eink-surface, #fbfbf7);
    --reader-surface-2: var(--reader-eink-surface-2, #efefe8);
    --reader-text: var(--reader-eink-text, #111111);
    --reader-muted: var(--reader-eink-muted, #555555);
    --reader-border: var(--reader-eink-border, rgba(17, 17, 17, 0.14));
    --reader-accent: var(--reader-eink-text, #111111);
    --reader-accent-soft: var(--reader-eink-accent-soft, rgba(17, 17, 17, 0.08));
}

@media (max-width: 900px) {
    .reader-toolbar {
        flex-direction: column;
        align-items: stretch;
    }

    .reader-toolbar-actions {
        justify-content: flex-start;
    }
}

@media (max-width: 640px) {
    .reader-toolbar {
        padding: 8px 8px 10px;
        gap: 8px;
    }

    .reader-toolbar-main {
        align-items: flex-start;
        gap: 8px;
    }

    .reader-back-btn {
        min-width: 42px;
        min-height: 42px;
    }

    .reader-back-btn :deep(.block) {
        display: none;
    }

    .reader-book-meta {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .reader-book-title {
        font-size: 15px;
        line-height: 1.15;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .reader-book-title.is-expanded {
        -webkit-line-clamp: initial;
        overflow: visible;
    }

    .reader-book-author {
        margin-top: 0;
        font-size: 12px;
        line-height: 1.2;
        display: -webkit-box;
        -webkit-line-clamp: 1;
        -webkit-box-orient: vertical;
        overflow: hidden;
    }

    .reader-book-author.is-expanded {
        -webkit-line-clamp: initial;
        overflow: visible;
    }

    .reader-book-progress {
        margin-top: 2px;
        font-size: 11px;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .reader-toolbar-quick-actions {
        gap: 4px;
        flex-shrink: 0;
    }

    .reader-icon-btn {
        width: 34px;
        height: 34px;
    }

    .reader-toolbar-actions {
        gap: 8px;
        padding-top: 2px;
    }

    .reader-theme-switch,
    .reader-stepper {
        width: 100%;
        justify-content: center;
        border-radius: 14px;
        min-height: 44px;
    }

    .reader-progress-text {
        width: 100%;
        min-width: 0;
        text-align: left;
        padding-left: 4px;
    }

    .reader-shell {
        padding: 10px 8px 18px;
    }

    .reader-body--paged {
        width: 100%;
        border-radius: 20px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
    }

    .reader-shell--paged-horizontal {
        padding-inline: 0;
    }

    .reader-cover {
        width: 140px;
        max-width: 46vw;
    }

    .reader-body {
        width: 100%;
    }

    .reader-mobile-bar {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .reader-mobile-btn {
        min-height: 40px;
        font-size: 11px;
        border-radius: 14px;
    }

    .reader-html :deep(p),
    .reader-paragraph {
        text-align: left;
    }
}
</style>
