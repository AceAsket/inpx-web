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
                        {{ readerHeaderTitle }}
                    </div>
                    <div
                        v-if="readerHeaderSubtitle"
                        class="reader-book-author"
                        :class="{'is-expanded': isCompactLayout && readerMetaExpanded}"
                        @click="toggleReaderMeta"
                    >
                        {{ readerHeaderSubtitle }}
                    </div>
                    <div
                        v-if="bookUid && !isCompactLayout"
                        class="reader-book-progress"
                        :class="{'is-clickable': hasReaderPlaces}"
                        @click="hasReaderPlaces && openPlacesDialog(defaultPlacesTab)"
                    >
                        {{ readerProgressLabel }}<span v-if="readerPageMeta"> | {{ readerPageMeta }}</span><span v-if="readerSectionMeta"> &middot; {{ readerSectionMeta }}</span>
                    </div>
                </div>

                <button
                    v-if="!isStandaloneMode"
                    type="button"
                    class="reader-profile-chip"
                    :class="readerProfileChipClass"
                    @click="handleReaderProfileChipClick"
                >
                    <q-icon :name="readerProfileChipIcon" />
                    <span>{{ readerProfileChipLabel }}</span>
                </button>

                <div v-if="bookUid" class="reader-toolbar-quick-actions">
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
                        v-if="isPagedMode"
                        flat
                        dense
                        round
                        icon="la la-search"
                        class="reader-icon-btn"
                        :class="{'is-active': searchDialogOpen}"
                        @click="toggleSearchDialog"
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
                        :icon="isBookMarkedRead ? 'la la-undo' : 'la la-check-circle'"
                        class="reader-icon-btn"
                        @click="toggleCurrentBookRead"
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
                        icon="la la-question-circle"
                        class="reader-icon-btn"
                        @click="toggleHelpDialog"
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

            <div v-show="bookUid && showToolbarActions" class="reader-toolbar-actions">
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

                <q-select
                    :model-value="selectedFontFamily"
                    :options="fontFamilyOptions"
                    class="reader-font-select"
                    popup-content-class="reader-font-menu"
                    :popup-content-style="readerDialogStyle"
                    borderless
                    dense
                    options-dense
                    emit-value
                    map-options
                    dropdown-icon="la la-angle-down"
                    @update:model-value="setFontFamily"
                />

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
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedDirection === 'vertical'}" @click="setPagedDirection('vertical')">{{ uiText.directionVertical }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pagedDirection === 'horizontal'}" @click="setPagedDirection('horizontal')">{{ uiText.directionHorizontal }}</q-btn>
                </div>

                <div v-if="activePreferences.readMode === 'paged'" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimation === 'none'}" @click="setPageAnimation('none')">{{ uiText.animationNone }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimation === 'soft'}" @click="setPageAnimation('soft')">{{ uiText.animationSoft }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimation === 'slide'}" @click="setPageAnimation('slide')">{{ uiText.animationSlide }}</q-btn>
                </div>

                <div v-if="activePreferences.readMode === 'paged'" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimationSpeed === 'fast'}" @click="setPageAnimationSpeed('fast')">{{ uiText.speedFast }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimationSpeed === 'normal'}" @click="setPageAnimationSpeed('normal')">{{ uiText.speedNormal }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.pageAnimationSpeed === 'slow'}" @click="setPageAnimationSpeed('slow')">{{ uiText.speedSlow }}</q-btn>
                </div>

                <div v-if="isCompactLayout" class="reader-theme-switch">
                    <q-btn flat dense no-caps :class="{'is-active': activePreferences.showStatusBar}" @click="setStatusBarVisible(true)">{{ uiText.statusBarOn }}</q-btn>
                    <q-btn flat dense no-caps :class="{'is-active': !activePreferences.showStatusBar}" @click="setStatusBarVisible(false)">{{ uiText.statusBarOff }}</q-btn>
                </div>

                <div class="reader-progress-text">
                    {{ displayProgressPercent }}%<span v-if="showDisplayPagedPageCounter"> | {{ displayCurrentPage }}/{{ displayTotalPages }}</span>
                </div>
            </div>
        </div>

        <div v-if="loading" class="reader-loading">
            <q-icon class="la la-spinner icon-rotate text-green-8" size="28px" />
            <div class="q-ml-sm">{{ loadingMessage || uiText.loadingBook }}</div>
        </div>

        <div v-else-if="error" class="reader-error">
            {{ error }}
        </div>

        <div v-else-if="!bookUid && !isStandaloneMode" class="reader-home">
            <div class="reader-home-panel">
                <div class="reader-home-head">
                    <div>
                        <div class="reader-home-kicker">{{ uiText.readerWebApp }}</div>
                        <h1 class="reader-home-title">{{ uiText.readerHomeTitle }}</h1>
                        <div class="reader-home-subtitle">{{ readerHomeSubtitle }}</div>
                    </div>
                    <div class="reader-home-actions">
                        <div class="reader-theme-switch reader-home-theme">
                            <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'dark'}" @click="setTheme('dark')">{{ uiText.themeDark }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'sepia'}" @click="setTheme('sepia')">{{ uiText.themeSepia }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'light'}" @click="setTheme('light')">{{ uiText.themeLight }}</q-btn>
                            <q-btn flat dense no-caps :class="{'is-active': preferences.theme === 'eink'}" @click="setTheme('eink')">{{ uiText.themeEink }}</q-btn>
                        </div>
                        <q-btn
                            v-if="readerHomeCanLogin && !isCompactLayout"
                            color="primary"
                            unelevated
                            no-caps
                            icon="la la-sign-in-alt"
                            @click="promptReaderProfileLogin"
                        >
                            {{ uiText.profileLoginAction }}
                        </q-btn>
                        <q-btn
                            flat
                            no-caps
                            icon="la la-sync"
                            @click="loadReaderHome"
                        >
                            {{ uiText.refresh }}
                        </q-btn>
                    </div>
                </div>

                <div v-if="readerHomeLoading" class="reader-home-state">
                    <q-icon class="la la-spinner icon-rotate" size="22px" />
                    <span>{{ uiText.loadingBook }}</span>
                </div>

                <div v-if="!readerHomeLoading" class="reader-home-tools">
                    <div class="reader-home-tabs">
                        <button
                            v-for="item in readerHomeFilterOptions"
                            :key="item.value"
                            type="button"
                            class="reader-home-tab"
                            :class="{'is-active': readerHomeFilter === item.value}"
                            @click="setReaderHomeFilter(item.value)"
                        >
                            {{ item.label }} <span>{{ readerHomeCounters[item.value] || 0 }}</span>
                        </button>
                    </div>

                    <div class="reader-home-search-row">
                        <q-input
                            v-model="readerHomeSearch"
                            dense
                            outlined
                            clearable
                            debounce="250"
                            class="reader-home-search"
                            :placeholder="uiText.readerHomeSearchPlaceholder"
                            @update:model-value="loadReaderHome"
                        >
                            <template v-slot:prepend>
                                <q-icon name="la la-search" />
                            </template>
                        </q-input>
                        <q-select
                            v-model="readerHomeSort"
                            :options="readerHomeSortOptions"
                            dense
                            outlined
                            emit-value
                            map-options
                            options-dense
                            class="reader-home-sort"
                            dropdown-icon="la la-angle-down"
                            @update:model-value="loadReaderHome"
                        />
                    </div>
                </div>

                <div v-if="!readerHomeLoading && readerHomeBooks.length" class="reader-home-list">
                    <div
                        v-for="book in readerHomeBooks"
                        :key="book.bookUid"
                        class="reader-home-book"
                    >
                        <div class="reader-home-book-main">
                            <div class="reader-home-book-title">{{ book.title || uiText.untitledBook }}</div>
                            <div v-if="book.author" class="reader-home-book-meta">{{ book.author }}</div>
                            <div v-if="book.series" class="reader-home-book-meta">
                                {{ uiText.series }}: {{ book.series }}<span v-if="book.serno"> #{{ book.serno }}</span>
                            </div>
                            <div class="reader-home-progress">
                                <div class="reader-home-progress-bar">
                                    <div class="reader-home-progress-fill" :style="{width: `${formatReaderHomePercent(book.percent)}%`}"></div>
                                </div>
                                <span>{{ formatReaderHomePercent(book.percent) }}%</span>
                            </div>
                        </div>
                        <div class="reader-home-book-actions">
                            <q-btn
                                v-if="!book.hidden"
                                color="primary"
                                unelevated
                                no-caps
                                icon="la la-book-open"
                                @click="openReaderHomeBook(book)"
                            >
                                {{ book.state === 'read' ? uiText.openBook : uiText.continueReading }}
                            </q-btn>
                            <q-btn
                                v-if="book.hidden"
                                color="primary"
                                unelevated
                                no-caps
                                icon="la la-undo"
                                @click="restoreReaderHomeBook(book)"
                            >
                                {{ uiText.restoreToReading }}
                            </q-btn>
                            <q-btn
                                v-if="!book.hidden"
                                flat
                                no-caps
                                color="negative"
                                icon="la la-times"
                                @click="removeReaderHomeBook(book)"
                            >
                                {{ uiText.removeFromReading }}
                            </q-btn>
                        </div>
                    </div>
                </div>

                <div v-else-if="!readerHomeLoading" class="reader-home-state reader-home-state--empty">
                    <q-icon name="la la-book-reader" size="28px" />
                    <div>
                        <div class="reader-home-empty-title">{{ uiText.readerHomeEmptyTitle }}</div>
                        <div class="reader-home-empty-text">{{ readerHomeEmptyText }}</div>
                    </div>
                </div>
            </div>
        </div>

        <template v-else>
            <div
                ref="scroller"
                class="reader-scroll"
                :class="{
                    'reader-scroll--paged': activePreferences.readMode === 'paged',
                }"
                @scroll="onScroll"
                @wheel="handleReaderWheel"
                @click="handleReaderTap"
                @touchstart.passive="handleReaderTouchStart"
                @touchend="handleReaderTouchEnd"
                @touchcancel="handleReaderTouchCancel"
            >
                <div
                    ref="readerShell"
                    class="reader-shell"
                    :class="{
                        'reader-shell--paged': activePreferences.readMode === 'paged',
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
                                <div class="reader-progress-bar-fill" :style="{width: `${displayProgressPercent}%`}"></div>
                            </div>

                            <div ref="readerHtml" class="reader-html" v-html="readerHtml"></div>
                        </template>

                        <template v-else>
                            <div class="reader-pages">
                                <div ref="pageStage" class="reader-page-stage">
                                    <transition :name="pagedTransitionName">
                                        <article
                                            v-if="activePagedPage"
                                            :key="`page-${currentPageIndex}-${activePagedPage.sectionId || 'page'}`"
                                            class="reader-page-sheet reader-page-sheet--live"
                                            :data-page-index="currentPageIndex"
                                        >
                                            <div class="reader-html" v-html="activePagedPageRenderedHtml"></div>
                                        </article>
                                    </transition>
                                    <article
                                        ref="pageMeasure"
                                        class="reader-page-sheet reader-page-sheet--measure"
                                        aria-hidden="true"
                                    >
                                        <div class="reader-html"></div>
                                    </article>
                                </div>
                            </div>
                        </template>
                    </div>
                </div>
            </div>

            <transition name="reader-reflow-fade">
                <div
                    v-if="showLayoutRefreshIndicator"
                    class="reader-reflow-indicator"
                    :class="{'reader-reflow-indicator--compact': isCompactChromeLayoutRefresh}"
                >
                    <div class="reader-reflow-card" :class="{'reader-reflow-card--compact': isCompactChromeLayoutRefresh}">
                        <q-icon class="la la-spinner icon-rotate" size="22px" />
                        <span>{{ uiText.refreshingLayout }}</span>
                    </div>
                </div>
            </transition>

            <transition name="reader-reflow-fade">
                <div v-if="bookPreparing" class="reader-reflow-indicator reader-reflow-indicator--strong">
                    <div class="reader-reflow-card reader-reflow-card--loading">
                        <q-icon class="la la-spinner icon-rotate" size="24px" />
                        <span>{{ loadingMessage || uiText.loadingBook }}</span>
                    </div>
                </div>
            </transition>

            <div v-if="readerDebugEnabled" class="reader-debug-panel">
                <div class="reader-debug-title">Reader Debug</div>
                <div>mode: {{ isCompactLayout ? 'mobile' : 'desktop' }} / {{ isPagedMode ? 'paged' : 'scroll' }}</div>
                <div>page: {{ currentPage }}/{{ totalPages }}</div>
                <div>measure available: {{ readerDebug.measureAvailableHeight }}px</div>
                <div>measure content: {{ readerDebug.measureContentHeight }}px</div>
                <div>measure overflow: {{ readerDebug.measureOverflowPx }}px</div>
                <div>sheet height: {{ readerDebug.liveSheetHeight }}px</div>
                <div>sheet bottom safe: {{ readerDebug.liveSafeBottom }}px</div>
                <div>text last bottom: {{ readerDebug.liveTextBottom }}px</div>
                <div>live overflow: {{ readerDebug.liveOverflowPx }}px</div>
                <div>clip base: {{ readerDebug.baseBottomClipCompensation }}px</div>
                <div>clip dynamic: {{ currentDynamicBottomClipCompensation }}px</div>
                <div>clip total: {{ readerDebug.totalBottomClipCompensation }}px</div>
                <div>safety inset: {{ readerDebug.pagedContentSafetyInset }}px</div>
                <div>font/line: {{ activePreferences.fontSize }} / {{ activePreferences.lineHeight }}</div>
                <div class="reader-debug-actions">
                    <button class="reader-debug-btn" @click.stop="adjustDebugBottomCompensation(-1)">- line</button>
                    <button class="reader-debug-btn" @click.stop="adjustDebugBottomCompensation(1)">+ line</button>
                    <button class="reader-debug-btn" @click.stop="resetDebugBottomCompensation">reset</button>
                </div>
            </div>
        </template>

        <div
            v-if="bookUid && isCompactLayout && (showCompactStatusBar || !compactChromeHidden)"
            ref="readerMobileFooter"
            class="reader-mobile-footer"
        >
            <div v-if="showCompactStatusBar" class="reader-status-bar">
                <template v-if="showCompactPagedBuildIndicator">
                    <q-icon class="la la-spinner icon-rotate reader-status-bar-spinner" size="14px" />
                    <span>{{ compactStatusBarBuildText }}</span>
                </template>
                <span v-else>{{ compactStatusBarText }}</span>
            </div>

            <div
                v-if="!compactChromeHidden"
                class="reader-mobile-bar"
                :class="{'reader-mobile-bar--with-contents': hasContents}"
            >
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
                        {{ displayProgressPercent }}%<span v-if="showDisplayPagedPageCounter"> | {{ displayCurrentPage }}/{{ displayTotalPages }}</span>
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

        <div v-if="fullscreenActive && helpDialogOpen" class="reader-overlay-panel" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ uiText.readerHelp }}</div>
                <q-btn flat dense round icon="la la-times" @click="helpDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <div class="reader-help-intro">{{ readerHelpIntro }}</div>
                <div v-for="item in readerHelpItems" :key="item" class="reader-help-item">{{ item }}</div>
            </div>
        </div>

        <div v-if="fullscreenActive && searchDialogOpen && isPagedMode" class="reader-overlay-panel" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
            <div class="reader-dialog-header">
                <div class="reader-dialog-title">{{ uiText.searchTitle }}</div>
                <q-btn flat dense round icon="la la-times" @click="searchDialogOpen = false" />
            </div>

            <div class="reader-dialog-body">
                <q-input
                    v-model="searchQuery"
                    dense
                    outlined
                    clearable
                    :placeholder="uiText.searchPlaceholder"
                    @update:model-value="handleSearchInput"
                    @keyup.enter="jumpToNextSearchResult"
                />
                <div class="reader-search-toolbar">
                    <q-btn flat dense no-caps icon="la la-angle-up" class="reader-inline-action-btn" :disable="!hasSearchResults" @click="jumpToPrevSearchResult">{{ uiText.searchPrev }}</q-btn>
                    <q-btn flat dense no-caps icon-right="la la-angle-down" class="reader-inline-action-btn" :disable="!hasSearchResults" @click="jumpToNextSearchResult">{{ uiText.searchNext }}</q-btn>
                </div>
                <div class="reader-search-meta">
                    <span v-if="hasSearchResults">{{ searchResultsLabel }}</span>
                    <span v-else-if="searchQuery.trim()">{{ uiText.searchEmpty }}</span>
                    <span v-else>{{ uiText.searchHint }}</span>
                </div>
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
                            {{ displayProgressPercent }}%<span v-if="showDisplayPagedPageCounter"> | {{ displayCurrentPage }}/{{ displayTotalPages }}</span>
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

        <q-dialog v-if="!fullscreenActive" v-model="helpDialogOpen" position="right">
            <div class="reader-dialog reader-dialog--contents" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">{{ uiText.readerHelp }}</div>
                    <q-btn flat dense round icon="la la-times" @click="helpDialogOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <div class="reader-help-intro">{{ readerHelpIntro }}</div>
                    <div v-for="item in readerHelpItems" :key="item" class="reader-help-item">{{ item }}</div>
                </div>
            </div>
        </q-dialog>

        <q-dialog v-if="!fullscreenActive && isPagedMode" v-model="searchDialogOpen" position="right">
            <div class="reader-dialog reader-dialog--contents" :class="readerThemeClass" :style="readerDialogSurfaceStyle">
                <div class="reader-dialog-header">
                    <div class="reader-dialog-title">{{ uiText.searchTitle }}</div>
                    <q-btn flat dense round icon="la la-times" @click="searchDialogOpen = false" />
                </div>

                <div class="reader-dialog-body">
                    <q-input
                        v-model="searchQuery"
                        dense
                        outlined
                        clearable
                        :placeholder="uiText.searchPlaceholder"
                        @update:model-value="handleSearchInput"
                        @keyup.enter="jumpToNextSearchResult"
                    />
                    <div class="reader-search-toolbar">
                        <q-btn flat dense no-caps icon="la la-angle-up" class="reader-inline-action-btn" :disable="!hasSearchResults" @click="jumpToPrevSearchResult">{{ uiText.searchPrev }}</q-btn>
                        <q-btn flat dense no-caps icon-right="la la-angle-down" class="reader-inline-action-btn" :disable="!hasSearchResults" @click="jumpToNextSearchResult">{{ uiText.searchNext }}</q-btn>
                    </div>
                    <div class="reader-search-meta">
                        <span v-if="hasSearchResults">{{ searchResultsLabel }}</span>
                        <span v-else-if="searchQuery.trim()">{{ uiText.searchEmpty }}</span>
                        <span v-else>{{ uiText.searchHint }}</span>
                    </div>
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
        readerSourceKey: {
            immediate: true,
            handler() {
                this.loadReader();// no await
            },
        },
        readerProfileWarningKey: {
            immediate: true,
            handler() {
                this.$nextTick(() => this.notifyReaderProfileWarning());
            },
        },
    },
};

class Reader {
    _options = componentOptions;
    _props = {
        standaloneSource: {
            type: Object,
            default: null,
        },
    };

    loading = false;
    loadingMessage = '';
    bookPreparing = false;
    pagedBuildProgressPercent = 0;
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
    helpDialogOpen = false;
    searchDialogOpen = false;
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
    searchQuery = '';
    searchResults = [];
    currentSearchResultIndex = -1;
    readerHomeLoading = false;
    readerHomeBooks = [];
    readerHomeCounters = {all: 0, reading: 0, read: 0, hidden: 0};
    readerHomeFilter = 'reading';
    readerHomeSort = 'updatedDesc';
    readerHomeSearch = '';
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
        pageAnimation: 'soft',
        pageAnimationSpeed: 'normal',
        showStatusBar: true,
        fontFamily: 'serif',
        fontSize: 18,
        lineHeight: 1.7,
        contentWidth: 820,
        einkProfile: {
            readMode: 'paged',
            pagedNavigation: 'tap',
            pagedDirection: 'vertical',
            pageAnimation: 'none',
            pageAnimationSpeed: 'fast',
            showStatusBar: true,
            fontFamily: 'serif',
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
    imageLayoutFrame = 0;
    pagedViewportFrame = 0;
    viewportRefreshFrame = 0;
    pagedBuildInProgress = false;
    pagedBuildNeedsRefresh = false;
    pagedBuildJobId = 0;
    compactChromePagedBuildPending = false;
    compactChromeAwaitingCalibration = false;
    compactChromeInitialTotalPages = 0;
    compactChromeLatestTotalPages = 0;
    compactChromeBuildSettleTimer = null;
    compactChromeBuildLastActivityAt = 0;
    compactChromeStatusHold = false;
    wakeLock = null;
    wakeLockSupported = false;
    wakeLockActive = false;
    wakeLockRequested = false;
    wakeLockError = '';
    profileWarningNotifiedKey = '';
    fontFamilyOptions = [
        {label: 'Serif', value: 'serif'},
        {label: 'Sans', value: 'sans'},
        {label: 'Mono', value: 'mono'},
        {label: 'System', value: 'system'},
    ];
    compactChromeStatusHoldTimer = null;
    compactChromeStatusHoldUntil = 0;
    boundReaderImages = new WeakSet();
    layoutRefreshing = false;
    layoutRefreshTimer = null;
    layoutRefreshStartedAt = 0;
    layoutRefreshReason = '';
    stableReaderStatus = {
        ready: false,
        progressPercent: 0,
        currentPage: 1,
        totalPages: 1,
        pageMeta: '',
        sectionMeta: '',
    };
    bottomCalibrationFrame = 0;
    bottomClipCalibrationPending = true;
    dynamicBottomClipCompensationCompact = 0;
    dynamicBottomClipCompensationRegular = 0;
    readerDebug = {
        measureAvailableHeight: 0,
        measureContentHeight: 0,
        measureOverflowPx: 0,
        liveSheetHeight: 0,
        liveSafeBottom: 0,
        liveTextBottom: 0,
        liveOverflowPx: 0,
        baseBottomClipCompensation: 0,
        totalBottomClipCompensation: 0,
        pagedContentSafetyInset: 0,
    };

    created() {
        this.handleBeforeUnload = () => {
            this.flushProgress();
        };
        this.handleFullscreenChange = () => {
            this.fullscreenActive = !!document.fullscreenElement;
            this.beginLayoutRefresh();
            this.requestBottomClipCalibration();
            this.runAfterLayoutRefreshPaint(() => {
                this.updateScrollerViewport();
                requestAnimationFrame(() => {
                    this.restoreProgress();
                    this.endLayoutRefresh(260);
                });
            });
        };
        this.handleWindowResize = () => {
            this.scheduleViewportRefresh();
        };
        this.handleVisualViewportResize = () => {
            this.scheduleViewportRefresh();
        };
        this.handleReaderKeydown = (event) => {
            this.handleGlobalKeydown(event);
        };
        this.handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && this.wakeLockRequested)
                this.requestWakeLock();// no await
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
        window.addEventListener('keydown', this.handleReaderKeydown);
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        this.wakeLockSupported = !!(navigator && navigator.wakeLock && navigator.wakeLock.request);
        this.requestWakeLock();// no await
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', this.handleVisualViewportResize);
        }
        this.handleFullscreenChange();
        this.$nextTick(() => {
            this.attachScrollerObserver();
            this.updateScrollerViewport();
            this.bindReaderImageListeners();
            this.notifyReaderProfileWarning();
        });
        setTimeout(() => this.notifyReaderProfileWarning(), 450);
    }

    updated() {
        this.bindReaderImageListeners();
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
        window.removeEventListener('keydown', this.handleReaderKeydown);
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', this.handleVisualViewportResize);
        }
        this.detachScrollerObserver();
        this.clearSnapTimer();
        clearTimeout(this.pageTurnTimer);
        if (this.imageLayoutFrame) {
            cancelAnimationFrame(this.imageLayoutFrame);
            this.imageLayoutFrame = 0;
        }
        if (this.pagedViewportFrame) {
            cancelAnimationFrame(this.pagedViewportFrame);
            this.pagedViewportFrame = 0;
        }
        if (this.viewportRefreshFrame) {
            cancelAnimationFrame(this.viewportRefreshFrame);
            this.viewportRefreshFrame = 0;
        }
        if (this.bottomCalibrationFrame) {
            cancelAnimationFrame(this.bottomCalibrationFrame);
            this.bottomCalibrationFrame = 0;
        }
        if (this.layoutRefreshTimer) {
            clearTimeout(this.layoutRefreshTimer);
            this.layoutRefreshTimer = null;
        }
        if (this.compactChromeStatusHoldTimer) {
            clearTimeout(this.compactChromeStatusHoldTimer);
            this.compactChromeStatusHoldTimer = null;
        }
        this.flushProgress();
        if (this.savePreferencesDebounced && this.savePreferencesDebounced.flush)
            this.savePreferencesDebounced.flush();
        this.releaseWakeLock();// no await
    }

    get bookUid() {
        return String(this.$route.query.bookUid || this.$route.params.bookUid || '').trim();
    }

    get isStandaloneMode() {
        return !!(this.standaloneSource && String(this.standaloneSource.fb2 || '').trim());
    }

    get config() {
        return this.$store.state.config || {};
    }

    get settings() {
        return this.$store.state.settings || {};
    }

    get currentUserId() {
        return this.settings.currentUserId || this.config.currentUserId || '';
    }

    get currentSelectedProfile() {
        const users = this.config.userProfiles || [];
        return users.find((item) => item.id === this.currentUserId) || this.config.currentUserProfile || null;
    }

    get readerProfileNeedsLogin() {
        const current = this.currentSelectedProfile;
        return !!(this.currentUserId && current && current.requiresLogin && !this.config.profileAuthorized);
    }

    get readerAnonymousProfile() {
        const current = this.currentSelectedProfile;
        return !!(current && current.anonymousProfile);
    }

    get readerProfileMissing() {
        return !!((!this.currentUserId || this.readerAnonymousProfile) && Array.isArray(this.config.userProfiles) && this.config.userProfiles.length);
    }

    get readerProfileWarningVisible() {
        return !this.isStandaloneMode && (this.readerProfileNeedsLogin || this.readerProfileMissing);
    }

    get readerProfileCanLogin() {
        return !!(this.readerProfileNeedsLogin || this.readerAnonymousProfile || (!this.currentUserId && Array.isArray(this.config.userProfiles) && this.config.userProfiles.length));
    }

    get readerProfileChipLabel() {
        const current = this.currentSelectedProfile;
        if (!current)
            return this.uiText.profileNotSelected;
        const profileName = current.name || this.uiText.profile;
        if (this.isCompactLayout) {
            if (this.readerProfileCanLogin)
                return this.uiText.profileLoginAction;
            return profileName;
        }
        if (this.readerAnonymousProfile)
            return `${profileName}: ${this.uiText.profileLoginAction}`;
        if (this.readerProfileCanLogin)
            return `${current.name || this.uiText.profile}: ${this.uiText.profileNeedsLoginShort}`;
        if (this.config.profileAuthorized)
            return profileName;
        return `${current.name || this.uiText.profile}: ${this.uiText.profileOpenShort}`;
    }

    get readerProfileChipClass() {
        if (!this.currentSelectedProfile)
            return 'reader-profile-chip--missing';
        if (this.readerProfileCanLogin)
            return 'reader-profile-chip--locked';
        if (this.config.profileAuthorized)
            return 'reader-profile-chip--authorized';
        return 'reader-profile-chip--open';
    }

    get readerProfileChipIcon() {
        if (!this.currentSelectedProfile)
            return 'la la-user-slash';
        if (this.readerProfileCanLogin)
            return 'la la-user-lock';
        if (this.config.profileAuthorized)
            return 'la la-user-check';
        return 'la la-user';
    }

    get readerHomeCanLogin() {
        return !!this.readerProfileCanLogin;
    }

    get readerProfileWarningKey() {
        if (!this.readerProfileWarningVisible)
            return '';

        if (this.readerProfileNeedsLogin)
            return `login:${this.currentUserId}`;

        return 'missing';
    }

    get readerProfileWarningTitle() {
        return this.readerProfileNeedsLogin ? this.uiText.profileLoginRequired : this.uiText.profileNotSelected;
    }

    get readerProfileWarningCaption() {
        return this.readerProfileNeedsLogin ? this.uiText.profileLoginReaderHint : this.uiText.profileSelectReaderHint;
    }

    get readerSourceKey() {
        if (this.isStandaloneMode) {
            const source = (this.standaloneSource || {});
            return `standalone:${String(source.sourceKey || source.fileName || source.title || source.fb2 || '').slice(0, 256)}`;
        }

        return this.bookUid ? `book:${this.bookUid}` : `reader-home:${this.currentUserId}:${this.config.profileAuthorized ? 'auth' : 'guest'}`;
    }

    get readerHeaderTitle() {
        return this.bookUid ? (this.title || this.uiText.readerHomeTitle) : this.uiText.readerHomeTitle;
    }

    get readerHeaderSubtitle() {
        return this.bookUid ? this.authorLine : this.readerHomeSubtitle;
    }

    get readerHomeAuthorized() {
        const current = this.currentSelectedProfile;
        return !!(current && !this.readerAnonymousProfile && (!current.requiresLogin || this.config.profileAuthorized));
    }

    get readerHomeSubtitle() {
        const current = this.currentSelectedProfile;
        if (!current)
            return this.uiText.profileSelectReaderHint;
        if (this.readerAnonymousProfile)
            return this.uiText.profileSelectReaderHint;
        if (this.readerProfileNeedsLogin)
            return this.uiText.profileLoginReaderHint;
        return current.name ? `${this.uiText.profile}: ${current.name}` : this.uiText.continueReading;
    }

    get readerHomeEmptyText() {
        if (!this.currentUserId || this.readerAnonymousProfile)
            return this.uiText.profileSelectReaderHint;
        if (this.readerProfileNeedsLogin)
            return this.uiText.profileLoginReaderHint;
        if (String(this.readerHomeSearch || '').trim())
            return this.uiText.readerHomeSearchEmptyText;
        if (this.readerHomeFilter === 'read')
            return this.uiText.readerHomeReadEmptyText;
        if (this.readerHomeFilter === 'hidden')
            return this.uiText.readerHomeHiddenEmptyText;
        return this.uiText.readerHomeEmptyText;
    }

    get readerHomeFilterOptions() {
        return [
            {value: 'reading', label: this.uiText.readerHomeFilterReading},
            {value: 'read', label: this.uiText.readerHomeFilterRead},
            {value: 'hidden', label: this.uiText.readerHomeFilterHidden},
            {value: 'all', label: this.uiText.readerHomeFilterAll},
        ];
    }

    get readerHomeSortOptions() {
        return [
            {value: 'updatedDesc', label: this.uiText.readerHomeSortUpdatedDesc},
            {value: 'updatedAsc', label: this.uiText.readerHomeSortUpdatedAsc},
            {value: 'titleAsc', label: this.uiText.readerHomeSortTitle},
            {value: 'authorAsc', label: this.uiText.readerHomeSortAuthor},
            {value: 'progressDesc', label: this.uiText.readerHomeSortProgressDesc},
            {value: 'progressAsc', label: this.uiText.readerHomeSortProgressAsc},
        ];
    }

    get readerDebugEnabled() {
        return ['1', 'true', 'yes', 'on'].includes(String(this.$route.query.debugReader || '').trim().toLowerCase());
    }

    get readerThemeClass() {
        return `reader-theme-${this.preferences.theme || 'dark'}`;
    }

    get readerDebugPreferenceOverrides() {
        if (!this.readerDebugEnabled)
            return {};

        const query = (this.$route && this.$route.query ? this.$route.query : {});
        const readMode = String(query.debugReadMode || '').trim().toLowerCase();
        const pagedDirection = String(query.debugPagedDirection || '').trim().toLowerCase();
        const result = {};

        if (readMode === 'paged' || readMode === 'scroll')
            result.readMode = readMode;
        if (pagedDirection === 'horizontal' || pagedDirection === 'vertical')
            result.pagedDirection = pagedDirection;

        return result;
    }

    get activePreferences() {
        const basePreferences = (this.preferences.theme === 'eink')
            ? Object.assign({}, this.preferences, this.preferences.einkProfile || {})
            : this.preferences;
        return Object.assign({}, basePreferences, this.readerDebugPreferenceOverrides);
    }

    getActivePreferencesForTheme(theme = '', basePreferences = null) {
        const source = Object.assign({}, (basePreferences || this.preferences || {}), {theme});
        return (theme === 'eink')
            ? Object.assign({}, source, source.einkProfile || {})
            : source;
    }

    layoutSignatureForPreferences(prefs = {}) {
        return [
            prefs.readMode || 'scroll',
            prefs.pagedDirection || 'vertical',
            prefs.fontFamily || 'serif',
            prefs.fontSize || 18,
            prefs.contentWidth || 820,
            prefs.lineHeight || 1.7,
        ].join('|');
    }

    normalizeFontFamily(value = '') {
        const normalized = String(value || '').trim().toLowerCase();
        return ['serif', 'sans', 'mono', 'system'].includes(normalized) ? normalized : 'serif';
    }

    get selectedFontFamily() {
        return this.normalizeFontFamily(this.activePreferences.fontFamily);
    }

    get readerFontFamilyCss() {
        switch (this.selectedFontFamily) {
            case 'sans':
                return 'Inter, Arial, Helvetica, sans-serif';
            case 'mono':
                return '"Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace';
            case 'system':
                return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
            case 'serif':
            default:
                return 'Georgia, "Times New Roman", Times, serif';
        }
    }

    async requestWakeLock() {
        this.wakeLockRequested = true;
        this.wakeLockError = '';
        if (!this.wakeLockSupported || document.visibilityState !== 'visible')
            return false;

        try {
            if (this.wakeLock)
                return true;

            this.wakeLock = await navigator.wakeLock.request('screen');
            this.wakeLockActive = true;
            this.wakeLock.addEventListener('release', () => {
                this.wakeLock = null;
                this.wakeLockActive = false;
            });
            return true;
        } catch (e) {
            this.wakeLockError = e.message || String(e);
            this.wakeLock = null;
            this.wakeLockActive = false;
            return false;
        }
    }

    async releaseWakeLock() {
        this.wakeLockRequested = false;
        const lock = this.wakeLock;
        this.wakeLock = null;
        this.wakeLockActive = false;
        if (lock && typeof lock.release === 'function') {
            try {
                await lock.release();
            } catch (e) {
                //
            }
        }
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

    get shouldUseStableReaderStatus() {
        return !!(this.stableReaderStatus.ready && (this.layoutRefreshing || this.isPagedBuildPending));
    }

    get displayProgressPercent() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.progressPercent : this.progressPercent;
    }

    get readerProgressLabel() {
        return `${this.uiText.readPrefix} ${this.displayProgressPercent}%`;
    }

    get isBookMarkedRead() {
        return this.progressPercent >= 100;
    }


    get uiText() {
        return {
            back: '\u041d\u0430\u0437\u0430\u0434',
            myPlaces: '\u041c\u043e\u0438 \u043c\u0435\u0441\u0442\u0430',
            continueReading: '\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c',
            bookmarks: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0438',
            notes: '\u0417\u0430\u043c\u0435\u0442\u043a\u0438',
            readerHelp: '\u041a\u0430\u043a \u0447\u0438\u0442\u0430\u0442\u044c',
            searchTitle: '\u041f\u043e\u0438\u0441\u043a \u043f\u043e \u0442\u0435\u043a\u0441\u0442\u0443',
            searchPlaceholder: '\u041d\u0430\u0439\u0442\u0438 \u0444\u0440\u0430\u0437\u0443 \u0438\u043b\u0438 \u0441\u043b\u043e\u0432\u043e',
            searchPrev: '\u041d\u0430\u0437\u0430\u0434',
            searchNext: '\u0414\u0430\u043b\u044c\u0448\u0435',
            searchEmpty: '\u0421\u043e\u0432\u043f\u0430\u0434\u0435\u043d\u0438\u0439 \u043d\u0435\u0442.',
            searchHint: '\u041f\u043e\u0438\u0441\u043a \u0438\u0449\u0435\u0442 \u043f\u043e \u0443\u0436\u0435 \u0440\u0430\u0437\u0431\u0438\u0442\u044b\u043c \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0430\u043c.',
            helpMobileIntro: '\u041c\u043e\u0431\u0438\u043b\u044c\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c',
            helpDesktopIntro: '\u0414\u0435\u0441\u043a\u0442\u043e\u043f\u043d\u044b\u0439 \u0440\u0435\u0436\u0438\u043c',
            bookmark: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            readShort: '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e',
            unreadShort: '\u0421\u043d\u044f\u0442\u044c',
            noBookmarks: '\u0423 \u044d\u0442\u043e\u0439 \u043a\u043d\u0438\u0433\u0438 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u0440\u0443\u0447\u043d\u044b\u0445 \u0437\u0430\u043a\u043b\u0430\u0434\u043e\u043a.',
            noNotes: '\u0417\u0430\u043c\u0435\u0442\u043e\u043a \u043f\u043e\u043a\u0430 \u043d\u0435\u0442.',
            newPlace: '\u041d\u043e\u0432\u043e\u0435 \u043c\u0435\u0441\u0442\u043e',
            noteLabel: '\u0417\u0430\u043c\u0435\u0442\u043a\u0430',
            simpleBookmark: '\u041f\u0440\u043e\u0441\u0442\u0430\u044f \u0437\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            saveAsNote: '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u043a\u0430\u043a \u0437\u0430\u043c\u0435\u0442\u043a\u0443',
            readPrefix: '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e',
            bookmarkAdded: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430 \u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u0430',
            noteSaved: '\u0417\u0430\u043c\u0435\u0442\u043a\u0430 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0430',
            readMarked: '\u041a\u043d\u0438\u0433\u0430 \u043f\u043e\u043c\u0435\u0447\u0435\u043d\u0430 \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043d\u043e\u0439',
            readUnmarked: '\u041e\u0442\u043c\u0435\u0442\u043a\u0430 \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e \u0441\u043d\u044f\u0442\u0430',
            bookmarkTitle: '\u0417\u0430\u043a\u043b\u0430\u0434\u043a\u0430',
            error: '\u041e\u0448\u0438\u0431\u043a\u0430',
            profileLoginRequired: '\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u043d\u0435 \u0432\u043e\u0448\u0451\u043b',
            profileNotSelected: '\u041f\u0440\u043e\u0444\u0438\u043b\u044c \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d',
            profileLoginReaderHint: '\u041f\u0440\u043e\u0433\u0440\u0435\u0441\u0441, \u0437\u0430\u043a\u043b\u0430\u0434\u043a\u0438 \u0438 \u043e\u0442\u043c\u0435\u0442\u043a\u0430 \u00ab\u043f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e\u00bb \u043d\u0430\u0447\u043d\u0443\u0442 \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u044c\u0441\u044f \u043f\u043e\u0441\u043b\u0435 \u0432\u0445\u043e\u0434\u0430.',
            profileSelectReaderHint: '\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u0440\u043e\u0444\u0438\u043b\u044c, \u0447\u0442\u043e\u0431\u044b \u0441\u043e\u0445\u0440\u0430\u043d\u044f\u0442\u044c \u043b\u0438\u0447\u043d\u044b\u0439 \u043f\u0440\u043e\u0433\u0440\u0435\u0441\u0441 \u0447\u0442\u0435\u043d\u0438\u044f.',
            profileLoginAction: '\u0412\u043e\u0439\u0442\u0438',
            profile: '\u041f\u0440\u043e\u0444\u0438\u043b\u044c',
            profileNeedsLoginShort: 'нужен вход',
            profileLoggedInShort: 'вход выполнен',
            profileOpenShort: 'без пароля',
            refresh: '\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c',
            readerWebApp: 'INPX Reader',
            readerHomeTitle: '\u0427\u0438\u0442\u0430\u043b\u043a\u0430',
            readerHomeEmptyTitle: '\u041d\u0435\u0442 \u043a\u043d\u0438\u0433 \u0432 \u0447\u0442\u0435\u043d\u0438\u0438',
            readerHomeEmptyText: '\u041e\u0442\u043a\u0440\u043e\u0439\u0442\u0435 \u043a\u043d\u0438\u0433\u0443 \u0438\u0437 \u043a\u0430\u0442\u0430\u043b\u043e\u0433\u0430, \u0438 \u043e\u043d\u0430 \u043f\u043e\u044f\u0432\u0438\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c.',
            readerHomeSearchPlaceholder: 'Быстрый поиск по своим книгам',
            readerHomeSearchEmptyText: 'По этому запросу в выбранном разделе ничего не найдено.',
            readerHomeReadEmptyText: 'Здесь появятся книги, вручную отмеченные прочитанными или дочитанные до конца.',
            readerHomeHiddenEmptyText: 'Скрытых книг нет. Если убрать книгу из чтения, её можно будет вернуть отсюда.',
            readerHomeFilterReading: 'Читаю',
            readerHomeFilterRead: 'Прочитано',
            readerHomeFilterHidden: 'Скрыто',
            readerHomeFilterAll: 'Все',
            readerHomeSortUpdatedDesc: 'Сначала новые',
            readerHomeSortUpdatedAsc: 'Сначала старые',
            readerHomeSortTitle: 'По названию',
            readerHomeSortAuthor: 'По автору',
            readerHomeSortProgressDesc: 'Прогресс по убыванию',
            readerHomeSortProgressAsc: 'Прогресс по возрастанию',
            openBook: 'Открыть',
            restoreToReading: 'Вернуть',
            restoreReadingSuccess: 'Книга возвращена в чтение',
            removeFromReading: '\u0423\u0431\u0440\u0430\u0442\u044c \u0438\u0437 \u0447\u0442\u0435\u043d\u0438\u044f',
            removeReadingConfirm: '\u0423\u0431\u0440\u0430\u0442\u044c \u043a\u043d\u0438\u0433\u0443 \u00ab{title}\u00bb \u0438\u0437 \u0442\u0435\u043a\u0443\u0449\u0435\u0433\u043e \u0447\u0442\u0435\u043d\u0438\u044f?',
            removeReadingSuccess: '\u041a\u043d\u0438\u0433\u0430 \u0443\u0431\u0440\u0430\u043d\u0430 \u0438\u0437 \u0442\u0435\u043a\u0443\u0449\u0435\u0433\u043e \u0447\u0442\u0435\u043d\u0438\u044f',
            untitledBook: '\u0411\u0435\u0437 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u044f',
            series: '\u0421\u0435\u0440\u0438\u044f',
            themeDark: '\u0422\u0451\u043c\u043d\u0430\u044f',
            themeSepia: '\u0421\u0435\u043f\u0438\u044f',
            themeLight: '\u0421\u0432\u0435\u0442\u043b\u0430\u044f',
            themeEink: 'eink',
            readModeScroll: '\u041b\u0435\u043d\u0442\u0430',
            readModePages: '\u0421\u0442\u0440\u0430\u043d\u0438\u0446\u044b',
            directionVertical: '\u0412\u0435\u0440\u0442\u0438\u043a\u0430\u043b\u044c\u043d\u043e',
            directionHorizontal: '\u0413\u043e\u0440\u0438\u0437\u043e\u043d\u0442\u0430\u043b\u044c\u043d\u043e',
            animationNone: '\u0411\u0435\u0437 \u0430\u043d\u0438\u043c\u0430\u0446\u0438\u0438',
            animationSoft: '\u041c\u044f\u0433\u043a\u043e',
            animationSlide: '\u0421\u043b\u0430\u0439\u0434',
            speedFast: '\u0411\u044b\u0441\u0442\u0440\u043e',
            speedNormal: '\u041d\u043e\u0440\u043c\u0430\u043b\u044c\u043d\u043e',
            speedSlow: '\u041c\u0435\u0434\u043b\u0435\u043d\u043d\u043e',
            statusBarOn: '\u0421\u0442\u0430\u0442\u0443\u0441 \u0432\u043d\u0438\u0437\u0443',
            statusBarOff: '\u0411\u0435\u0437 \u0441\u0442\u0430\u0442\u0443\u0441\u0430',
            einkContrast: '\u041a\u043e\u043d\u0442\u0440\u0430\u0441\u0442',
            einkPaper: '\u0411\u0443\u043c\u0430\u0433\u0430',
            einkInk: '\u0427\u0435\u0440\u043d\u0438\u043b\u0430',
            loadingBook: '\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430 \u043a\u043d\u0438\u0433\u0438...',
            loadingFetch: '\u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430 \u043a\u043d\u0438\u0433\u0438...',
            loadingParse: '\u041f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043a\u0430 \u0442\u0435\u043a\u0441\u0442\u0430...',
            loadingPages: '\u0420\u0430\u0437\u0431\u0438\u0432\u043a\u0430 \u043d\u0430 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b...',
            loadingPagesCompact: '\u0421\u0447\u0438\u0442\u0430\u044e \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b...',
            refreshingPagesCompact: '\u041f\u0435\u0440\u0435\u0441\u0442\u0440\u0430\u0438\u0432\u0430\u044e \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b...',
            contents: '\u0421\u043e\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435',
            show: '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u044c',
            hide: '\u0421\u043a\u0440\u044b\u0442\u044c',
            settings: '\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',
            screen: '\u042d\u043a\u0440\u0430\u043d',
            refreshingLayout: '\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435 \u0432\u0438\u0434\u0430...',
        };
    }

    get readerHelpIntro() {
        return (this.isCompactLayout ? this.uiText.helpMobileIntro : this.uiText.helpDesktopIntro);
    }

    get readerHelpItems() {
        if (this.isPagedMode) {
            if (this.isCompactLayout) {
                return [
                    '\u041a\u0430\u0441\u0430\u043d\u0438\u0435 \u043f\u043e \u0432\u0435\u0440\u0445\u0443/\u043d\u0438\u0437\u0443 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b \u043b\u0438\u0441\u0442\u0430\u0435\u0442 \u043a\u043d\u0438\u0433\u0443.',
                    '\u0421\u0432\u0430\u0439\u043f \u0432\u0432\u0435\u0440\u0445/\u0432\u043d\u0438\u0437 \u0438\u043b\u0438 \u0432\u043b\u0435\u0432\u043e/\u0432\u043f\u0440\u0430\u0432\u043e \u0442\u043e\u0436\u0435 \u043f\u0435\u0440\u0435\u043b\u0438\u0441\u0442\u044b\u0432\u0430\u0435\u0442.',
                    '\u041a\u0430\u0441\u0430\u043d\u0438\u0435 \u043f\u043e \u0446\u0435\u043d\u0442\u0440\u0443 \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u0438\u043b\u0438 \u0441\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u043f\u0430\u043d\u0435\u043b\u0438.',
                    '\u041a\u043d\u043e\u043f\u043a\u0430 \u00ab?\u00bb \u0432\u0441\u0435\u0433\u0434\u0430 \u043e\u0442\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u044d\u0442\u0443 \u043f\u043e\u0434\u0441\u043a\u0430\u0437\u043a\u0443.',
                ];
            }

            return [
                '\u041a\u043b\u0438\u043a \u043f\u043e \u0432\u0435\u0440\u0445\u043d\u0435\u0439/\u043d\u0438\u0436\u043d\u0435\u0439 \u0437\u043e\u043d\u0435 \u0438\u043b\u0438 \u043f\u043e \u043b\u0435\u0432\u043e\u0439/\u043f\u0440\u0430\u0432\u043e\u0439 \u0437\u043e\u043d\u0435 \u043b\u0438\u0441\u0442\u0430\u0435\u0442 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u044b.',
                '\u041a\u043e\u043b\u0435\u0441\u043e \u043c\u044b\u0448\u0438 \u0442\u043e\u0436\u0435 \u043b\u0438\u0441\u0442\u0430\u0435\u0442 \u043a\u043d\u0438\u0433\u0443.',
                '\u041a\u043b\u0430\u0432\u0438\u0448\u0438 `\u2190 \u2192 \u2191 \u2193`, `PageUp`, `PageDown` \u0438 `Space` \u0440\u0430\u0431\u043e\u0442\u0430\u044e\u0442 \u0434\u043b\u044f \u043d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u0438.',
                '\u041a\u043b\u0438\u043a \u043f\u043e \u0446\u0435\u043d\u0442\u0440\u0443 \u043f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u0438\u043b\u0438 \u0441\u043a\u0440\u044b\u0432\u0430\u0435\u0442 \u043f\u0430\u043d\u0435\u043b\u0438.',
            ];
        }

        if (this.isCompactLayout) {
            return [
                '\u041b\u0438\u0441\u0442\u0430\u0439\u0442\u0435 \u043a\u043d\u0438\u0433\u0443 \u043e\u0431\u044b\u0447\u043d\u044b\u043c \u0441\u043a\u0440\u043e\u043b\u043b\u043e\u043c \u0438\u043b\u0438 \u0441\u0432\u0430\u0439\u043f\u043e\u043c.',
                '\u041d\u0438\u0436\u043d\u044f\u044f \u043f\u0430\u043d\u0435\u043b\u044c \u0434\u0430\u0451\u0442 \u0431\u044b\u0441\u0442\u0440\u044b\u0439 \u0434\u043e\u0441\u0442\u0443\u043f \u043a \u043c\u0435\u0441\u0442\u0430\u043c, \u043e\u0433\u043b\u0430\u0432\u043b\u0435\u043d\u0438\u044e \u0438 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0430\u043c.',
                '\u041a\u043d\u043e\u043f\u043a\u0430 \u00ab?\u00bb \u0432 \u043b\u044e\u0431\u043e\u0439 \u043c\u043e\u043c\u0435\u043d\u0442 \u043e\u0442\u043a\u0440\u043e\u0435\u0442 \u044d\u0442\u0443 \u043f\u0430\u043c\u044f\u0442\u043a\u0443.',
            ];
        }

        return [
            '\u0412 \u0440\u0435\u0436\u0438\u043c\u0435 \u00ab\u043b\u0435\u043d\u0442\u0430\u00bb \u043a\u043d\u0438\u0433\u0430 \u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044f \u043e\u0431\u044b\u0447\u043d\u044b\u043c \u0441\u043a\u0440\u043e\u043b\u043b\u043e\u043c.',
            '\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u0443\u0439\u0442\u0435 \u043c\u044b\u0448\u044c, \u0442\u0430\u0447\u043f\u0430\u0434 \u0438\u043b\u0438 \u043a\u043b\u0430\u0432\u0438\u0448\u0438 `PageUp`/`PageDown`, `Space`, `Home`, `End`.',
            '\u041e\u0433\u043b\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u0438 \u00ab\u041c\u043e\u0438 \u043c\u0435\u0441\u0442\u0430\u00bb \u043f\u043e\u043c\u043e\u0433\u0430\u044e\u0442 \u0431\u044b\u0441\u0442\u0440\u043e \u0432\u0435\u0440\u043d\u0443\u0442\u044c\u0441\u044f \u043a \u043d\u0443\u0436\u043d\u043e\u043c\u0443 \u0444\u0440\u0430\u0433\u043c\u0435\u043d\u0442\u0443.',
        ];
    }

    get compactProgressHint() {
        return (this.showDisplayPagedPageCounter)
            ? `${this.displayProgressPercent}% | ${this.displayCurrentPage}/${this.displayTotalPages}`
            : `${this.displayProgressPercent}%`;
    }

    get compactStatusBarText() {
        return (this.showDisplayPagedPageCounter)
            ? `${this.readerProgressLabel} | ${this.displayCurrentPage}/${this.displayTotalPages}`
            : this.readerProgressLabel;
    }

    get compactStatusBarBuildText() {
        const sourceMessage = String(this.loadingMessage || '').trim();
        const isActivePagedBuild = !!(this.bookPreparing || this.isPagedBuildPending);
        const hasMeasuredProgress = isActivePagedBuild && this.pagedBuildProgressPercent > 0;
        let pagesMessage = '';

        if (
            isActivePagedBuild
            && sourceMessage
            && sourceMessage.startsWith(this.uiText.loadingPages.replace('...', ''))
        )
            pagesMessage = sourceMessage;
        else if (hasMeasuredProgress)
            pagesMessage = `${this.uiText.loadingPagesCompact.replace('...', '')} ${this.pagedBuildProgressPercent}%`;
        else if (this.isCompactChromeBuildPending || this.compactChromeStatusHold)
            pagesMessage = this.uiText.refreshingPagesCompact;
        else
            pagesMessage = this.uiText.loadingPagesCompact;

        return `${this.readerProgressLabel} · ${pagesMessage}`;
    }

    get isPagedBuildPending() {
        return !!(this.isPagedMode && (this.bookPreparing || this.pagedBuildInProgress));
    }

    get showCompactPagedBuildIndicator() {
        return !!(
            this.isCompactLayout
            && this.showCompactStatusBar
            && (this.isPagedBuildPending || this.isCompactChromeBuildPending || this.compactChromeStatusHold)
        );
    }

    get isCompactChromeBuildPending() {
        return !!(
            this.layoutRefreshReason === 'compact-chrome'
            || this.compactChromePagedBuildPending
            || this.compactChromeAwaitingCalibration
        );
    }

    get showPagedPageCounter() {
        return !!(this.isPagedMode && !this.isPagedBuildPending && this.totalPages > 1);
    }

    get showDisplayPagedPageCounter() {
        if (this.shouldUseStableReaderStatus)
            return !!this.stableReaderStatus.pageMeta;

        return this.showPagedPageCounter;
    }

    get displayCurrentPage() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.currentPage : this.currentPage;
    }

    get displayTotalPages() {
        return this.shouldUseStableReaderStatus ? this.stableReaderStatus.totalPages : this.totalPages;
    }

    get showLayoutRefreshIndicator() {
        return !!(
            this.layoutRefreshing
            && !this.bookPreparing
            && (!this.pagedBuildInProgress || this.layoutRefreshReason === 'compact-chrome')
        );
    }

    get isCompactChromeLayoutRefresh() {
        return this.layoutRefreshReason === 'compact-chrome';
    }

    get activePagedPage() {
        if (!this.isPagedMode || !this.pagedPages.length)
            return null;

        return this.pagedPages[Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex))] || null;
    }

    get currentDynamicBottomClipCompensation() {
        return (this.isCompactLayout
            ? (Number(this.dynamicBottomClipCompensationCompact || 0) || 0)
            : (Number(this.dynamicBottomClipCompensationRegular || 0) || 0));
    }

    get activePagedPageRenderedHtml() {
        const page = this.activePagedPage;
        if (!page)
            return '';

        if (!this.searchQuery.trim() || !this.hasSearchResults)
            return page.html || '';

        const activeResult = this.searchResults[this.currentSearchResultIndex] || null;
        if (!activeResult || activeResult.pageIndex !== this.currentPageIndex)
            return page.html || '';

        return this.highlightHtmlMatches(page.html || '', this.searchQuery);
    }

    get hasSearchResults() {
        return this.searchResults.length > 0;
    }

    get searchResultsLabel() {
        if (!this.hasSearchResults)
            return '';
        return `${this.currentSearchResultIndex + 1}/${this.searchResults.length} | ${this.uiText.readModePages} ${this.searchResults[this.currentSearchResultIndex].pageIndex + 1}`;
    }

    get pagedTransitionName() {
        if (this.isHorizontalPaged)
            return (this.pageTurnDirection < 0 ? 'reader-page-slide-x-back' : 'reader-page-slide-x-forward');

        return (this.pageTurnDirection < 0 ? 'reader-page-slide-y-back' : 'reader-page-slide-y-forward');
    }

    get readerPageMeta() {
        const sectionMeta = this.shouldUseStableReaderStatus
            ? (this.stableReaderStatus.sectionMeta || '')
            : (this.isCompactLayout ? '' : this.currentSectionTitle);
        if (sectionMeta)
            return '';

        if (this.shouldUseStableReaderStatus)
            return this.stableReaderStatus.pageMeta || '';

        return (this.showPagedPageCounter)
            ? `${this.currentPage}/${this.totalPages}`
            : '';
    }

    get readerSectionMeta() {
        if (this.shouldUseStableReaderStatus)
            return this.stableReaderStatus.sectionMeta || '';

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

    get pageAnimationDurationMs() {
        const speed = String(this.activePreferences.pageAnimationSpeed || 'normal');
        if (speed === 'fast')
            return 90;
        if (speed === 'slow')
            return 320;
        return 180;
    }

    get pageAnimationShiftPx() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 0;
        if (animation === 'slide')
            return 34;
        return 0;
    }

    get pageAnimationOpacityStart() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 1;
        if (animation === 'slide')
            return 0;
        return 0.15;
    }

    get pageAnimationScaleStart() {
        const animation = String(this.activePreferences.pageAnimation || 'soft');
        if (animation === 'none')
            return 1;
        if (animation === 'slide')
            return 1;
        return 0.992;
    }

    get readerShellVerticalPadding() {
        const shell = (this.$refs ? this.$refs.readerShell : null);
        if (!shell || typeof window === 'undefined' || !window.getComputedStyle)
            return 0;

        const style = window.getComputedStyle(shell);
        const padTop = parseFloat(style.paddingTop || '0') || 0;
        const padBottom = parseFloat(style.paddingBottom || '0') || 0;
        return padTop + padBottom;
    }

    get compactVisibleScrollerHeight() {
        if (!this.isCompactLayout || typeof window === 'undefined')
            return 0;

        const scroller = (this.$refs ? this.$refs.scroller : null);
        if (!scroller || !window.visualViewport)
            return 0;

        const rect = scroller.getBoundingClientRect();
        const viewportHeight = Number(window.visualViewport.height || 0) || 0;
        if (!viewportHeight)
            return 0;

        return Math.max(0, Math.min(
            rect.height || 0,
            viewportHeight - Math.max(0, rect.top || 0),
        ));
    }

    get readerMobileFooterHeight() {
        if (!this.isCompactLayout)
            return 0;

        const footer = (this.$refs ? this.$refs.readerMobileFooter : null);
        if (!footer)
            return 0;

        const rect = (typeof footer.getBoundingClientRect === 'function')
            ? footer.getBoundingClientRect()
            : null;

        return Math.max(0, Math.round((rect && rect.height) || footer.offsetHeight || 0));
    }

    get readerBodyStyle() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        const pagePaddingX = (this.isCompactLayout ? 20 : 64);
        const fallbackHeight = Math.max((this.isCompactLayout ? 120 : 180), scrollerHeight - (this.isCompactLayout ? 20 : 56));
        const pageHeight = Math.max((this.isCompactLayout ? 120 : 180), this.pageMinHeight || fallbackHeight);
        const pageColumnWidth = Math.max(180, this.pageFrameWidth - pagePaddingX - 2);
        return {
            '--reader-font-size': `${this.activePreferences.fontSize}px`,
            '--reader-font-family': this.readerFontFamilyCss,
            '--reader-line-height': String(this.activePreferences.lineHeight),
            '--reader-content-width': `${this.activePreferences.contentWidth}px`,
            '--reader-page-min-height': `${pageHeight}px`,
            '--reader-page-gap': `${this.pageGap}px`,
            '--reader-page-frame-width': `${this.pageFrameWidth}px`,
            '--reader-page-column-width': `${pageColumnWidth}px`,
            '--reader-page-padding': (this.isCompactLayout ? '10px 8px 12px' : '28px 32px 44px'),
            '--reader-page-media-max-height': `${Math.max(120, pageHeight - (this.isCompactLayout ? 60 : 128))}px`,
            '--reader-page-transition-duration': `${this.pageAnimationDurationMs}ms`,
            '--reader-page-shift-x': `${this.pageAnimationShiftPx}px`,
            '--reader-page-shift-y': `${Math.max(0, Math.round(this.pageAnimationShiftPx * 0.72))}px`,
            '--reader-page-enter-opacity': String(this.pageAnimationOpacityStart),
            '--reader-page-enter-scale': String(this.pageAnimationScaleStart),
        };
    }

    get pageGap() {
        return (this.isCompactLayout ? 18 : 32);
    }

    get pageFrameWidth() {
        const scrollerWidth = (this.scrollerViewportWidth || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientWidth) || 0));
        const reservedGap = (this.isCompactLayout ? 6 : 120);
        return Math.max(280, Math.min(this.activePreferences.contentWidth, Math.max(280, scrollerWidth - reservedGap)));
    }

    get pageMinHeight() {
        const scrollerHeight = (this.scrollerViewportHeight || ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0));
        if (this.isCompactLayout) {
            const visibleScrollerHeight = this.compactVisibleScrollerHeight || 0;
            const availableHeight = (visibleScrollerHeight
                ? Math.min(Math.max(0, scrollerHeight || visibleScrollerHeight), visibleScrollerHeight)
                : scrollerHeight);
            return Math.max(120, availableHeight - this.readerShellVerticalPadding);
        }
        const chromeOffset = 72;
        return Math.max(180, scrollerHeight - chromeOffset);
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
        const willOpen = !this.controlsOpen;
        this.controlsOpen = willOpen;
        if (!willOpen && this.bookUid)
            this.$nextTick(() => this.reflowReaderLayout());
    }

    toggleContentsDialog() {
        this.contentsDialogOpen = !this.contentsDialogOpen;
    }

    toggleHelpDialog() {
        this.helpDialogOpen = !this.helpDialogOpen;
    }

    async toggleCompactChromeVisibility() {
        this.beginLayoutRefresh('compact-chrome');
        if (this.isPagedMode) {
            this.compactChromePagedBuildPending = true;
            this.compactChromeAwaitingCalibration = true;
            this.compactChromeInitialTotalPages = Math.max(1, this.totalPages || 1);
            this.compactChromeLatestTotalPages = this.compactChromeInitialTotalPages;
            this.beginCompactChromeStatusHold();
        }
        this.touchCompactChromeBuildActivity();
        this.cancelCompactChromeBuildPendingClear();
        await this.afterLayoutRefreshPaint();

        this.chromeHidden = !this.chromeHidden;
        if (this.chromeHidden) {
            this.controlsOpen = false;
            this.contentsDialogOpen = false;
            this.helpDialogOpen = false;
        }

        this.$nextTick(() => {
            this.runAfterLayoutRefreshPaint(() => {
                this.updateScrollerViewport();
                requestAnimationFrame(() => {
                    if (this.isPagedMode)
                        this.setCurrentPagedPage(this.currentPageIndex, false);
                    this.endLayoutRefresh(180);
                });
            });
        });
    }

    toggleSearchDialog() {
        if (!this.isPagedMode)
            return;

        this.searchDialogOpen = !this.searchDialogOpen;
    }

    adjustDebugBottomCompensation(direction = 1) {
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.2, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const step = Math.max(8, Math.round(fontSize * lineHeight));
        const delta = (direction < 0 ? -step : step);

        if (this.isCompactLayout) {
            this.dynamicBottomClipCompensationCompact = Math.max(0, Math.min(240, (Number(this.dynamicBottomClipCompensationCompact || 0) || 0) + delta));
        } else {
            this.dynamicBottomClipCompensationRegular = Math.max(0, Math.min(320, (Number(this.dynamicBottomClipCompensationRegular || 0) || 0) + delta));
        }

        this.reflowReaderLayout();
    }

    formatReaderHomePercent(value) {
        return Math.max(0, Math.min(100, Math.round((Number(value || 0) || 0) * 100)));
    }

    async loadReaderHome() {
        if (this.isStandaloneMode || this.bookUid)
            return;

        this.readerHomeLoading = true;
        this.error = '';
        this.loading = false;
        this.bookPreparing = false;
        this.readerHtml = '';
        this.contents = [];
        this.bookmarks = [];
        this.title = this.uiText.readerHomeTitle;
        this.authorLine = '';
        this.seriesLine = '';
        this.$root.setAppTitle(this.uiText.readerHomeTitle);

        try {
            const api = this.$root.api;
            if (api && typeof api.updateConfig === 'function')
                await api.updateConfig();

            if (api && typeof api.getUserReadingLibrary === 'function' && this.readerHomeAuthorized) {
                const result = await api.getUserReadingLibrary({
                    state: this.readerHomeFilter,
                    sort: this.readerHomeSort,
                    query: this.readerHomeSearch,
                    limit: 300,
                });
                this.readerHomeCounters = Object.assign({all: 0, reading: 0, read: 0, hidden: 0}, result.counters || {});
                this.readerHomeBooks = Array.isArray(result.items)
                    ? result.items.filter((book) => String(book.bookUid || '').trim())
                    : [];
            } else {
                const current = this.$store.state.config.currentUserProfile || {};
                this.readerHomeCounters = {all: 0, reading: 0, read: 0, hidden: 0};
                this.readerHomeBooks = Array.isArray(current.currentReading)
                    ? current.currentReading.filter((book) => String(book.bookUid || '').trim())
                    : [];
                this.readerHomeCounters.reading = this.readerHomeBooks.length;
                this.readerHomeCounters.all = this.readerHomeBooks.length;
            }
        } catch (e) {
            this.error = e.message || String(e);
        } finally {
            this.readerHomeLoading = false;
            this.$nextTick(() => this.notifyReaderProfileWarning());
        }
    }

    openReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        this.$router.push({path: '/reader', query: {bookUid}});
    }

    setReaderHomeFilter(value = 'reading') {
        const nextValue = String(value || 'reading').trim();
        if (this.readerHomeFilter === nextValue)
            return;

        this.readerHomeFilter = nextValue;
        this.loadReaderHome();// no await
    }

    async removeReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            this.uiText.removeReadingConfirm.replace('{title}', String(book.title || this.uiText.untitledBook)),
            this.uiText.readerHomeTitle,
        );
        if (!confirmed)
            return;

        try {
            await this.$root.api.updateReaderProgress(bookUid, {
                hidden: true,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
            });
            await this.loadReaderHome();
            this.$root.notify.success(this.uiText.removeReadingSuccess, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message || String(e), this.uiText.error);
        }
    }

    async restoreReaderHomeBook(book = {}) {
        const bookUid = String(book.bookUid || '').trim();
        if (!bookUid)
            return;

        try {
            await this.$root.api.updateReaderProgress(bookUid, {
                hidden: false,
                percent: Number(book.percent || 0) || 0,
                sectionId: String(book.sectionId || '').trim(),
            });
            await this.loadReaderHome();
            this.$root.notify.success(this.uiText.restoreReadingSuccess, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message || String(e), this.uiText.error);
        }
    }

    resetDebugBottomCompensation() {
        if (this.isCompactLayout)
            this.dynamicBottomClipCompensationCompact = 0;
        else
            this.dynamicBottomClipCompensationRegular = 0;

        this.reflowReaderLayout();
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

    async setReadMode(mode = 'scroll') {
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.updateActivePreferences({
            readMode: (mode === 'paged' ? 'paged' : 'scroll'),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    async setPagedDirection(direction = 'vertical') {
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.updateActivePreferences({
            pagedDirection: (direction === 'horizontal' ? 'horizontal' : 'vertical'),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    setPageAnimation(mode = 'soft') {
        this.updateActivePreferences({
            pageAnimation: (['none', 'soft', 'slide'].includes(mode) ? mode : 'soft'),
        });
        this.savePreferencesDebounced();
    }

    setPageAnimationSpeed(speed = 'normal') {
        this.updateActivePreferences({
            pageAnimationSpeed: (['fast', 'normal', 'slow'].includes(speed) ? speed : 'normal'),
        });
        this.savePreferencesDebounced();
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
            if (this.controlsOpen)
                return;
            this.scheduleViewportRefresh({calibrate: false});
        });
        this.resizeObserver.observe(this.$refs.scroller);
    }

    detachScrollerObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    scheduleViewportRefresh({calibrate = true} = {}) {
        if (typeof window === 'undefined')
            return;

        if (calibrate)
            this.requestBottomClipCalibration();

        if (this.compactChromePagedBuildPending && this.isPagedMode)
            this.cancelCompactChromeBuildPendingClear();
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        if (this.viewportRefreshFrame)
            return;

        this.viewportRefreshFrame = requestAnimationFrame(() => {
            this.viewportRefreshFrame = 0;
            this.updateScrollerViewport();
        });
    }

    updateScrollerViewport() {
        const scroller = (this.$refs ? this.$refs.scroller : null);
        this.scrollerViewportWidth = ((scroller && scroller.clientWidth) || 0);
        this.scrollerViewportHeight = ((scroller && scroller.clientHeight) || 0);
        if (this.isPagedMode) {
            if (this.compactChromePagedBuildPending)
                this.touchCompactChromeBuildActivity();
            if (this.pagedBuildInProgress) {
                this.pagedBuildNeedsRefresh = true;
                return;
            }
            this.schedulePagedViewportBuild();
            return;
        }
        this.applyVerticalSectionAlignment();
    }

    schedulePagedViewportBuild() {
        if (typeof window === 'undefined')
            return;
        if (this.pagedBuildInProgress) {
            this.pagedBuildNeedsRefresh = true;
            return;
        }

        if (this.compactChromePagedBuildPending && this.isPagedMode)
            this.cancelCompactChromeBuildPendingClear();
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        if (this.pagedViewportFrame) {
            cancelAnimationFrame(this.pagedViewportFrame);
            this.pagedViewportFrame = 0;
        }

        this.$nextTick(() => {
            this.pagedViewportFrame = requestAnimationFrame(async() => {
                this.pagedViewportFrame = 0;
                if (!this.isPagedMode)
                    return;

                await this.waitForStablePagedStage();
                if (!this.isPagedMode)
                    return;

                this.pagedBuildJobId += 1;
                await this.buildPagedPagesChunked(this.pagedBuildJobId);
                this.syncPagedProgress(false);
                if (this.bottomClipCalibrationPending)
                    this.scheduleBottomClipCalibration();
            });
        });
    }

    requestBottomClipCalibration() {
        this.bottomClipCalibrationPending = true;
    }

    cancelCompactChromeBuildPendingClear() {
        if (!this.compactChromeBuildSettleTimer)
            return;

        clearTimeout(this.compactChromeBuildSettleTimer);
        this.compactChromeBuildSettleTimer = null;
    }

    clearCompactChromeStatusHold() {
        if (this.compactChromeStatusHoldTimer) {
            clearTimeout(this.compactChromeStatusHoldTimer);
            this.compactChromeStatusHoldTimer = null;
        }
        this.compactChromeStatusHold = false;
        this.compactChromeStatusHoldUntil = 0;
    }

    beginCompactChromeStatusHold(delayMs = 9000) {
        const safeDelay = Math.max(1200, Math.round(Number(delayMs || 0) || 0));
        const nextUntil = Date.now() + safeDelay;
        this.compactChromeStatusHoldUntil = Math.max(this.compactChromeStatusHoldUntil || 0, nextUntil);
        this.compactChromeStatusHold = true;
        if (this.compactChromeStatusHoldTimer)
            clearTimeout(this.compactChromeStatusHoldTimer);
        const waitMs = Math.max(1200, this.compactChromeStatusHoldUntil - Date.now());
        this.compactChromeStatusHoldTimer = setTimeout(() => {
            this.compactChromeStatusHoldTimer = null;
            this.compactChromeStatusHold = false;
            this.compactChromeStatusHoldUntil = 0;
        }, waitMs);
    }

    touchCompactChromeBuildActivity() {
        this.compactChromeBuildLastActivityAt = Date.now();
        if (this.compactChromeStatusHold)
            this.beginCompactChromeStatusHold(2600);
    }

    scheduleCompactChromeBuildPendingClear(delayMs = 420) {
        this.cancelCompactChromeBuildPendingClear();
        const quietWindowMs = 900;
        this.compactChromeBuildSettleTimer = setTimeout(() => {
            this.compactChromeBuildSettleTimer = null;
            const elapsedSinceActivity = Math.max(0, Date.now() - (this.compactChromeBuildLastActivityAt || 0));
            const hasQueuedWork = !!(
                this.layoutRefreshing
                || this.viewportRefreshFrame
                || this.pagedViewportFrame
                || this.pagedBuildInProgress
                || this.pagedBuildNeedsRefresh
                || this.compactChromeAwaitingCalibration
                || this.bottomClipCalibrationPending
                || this.bottomCalibrationFrame
            );
            if (hasQueuedWork || elapsedSinceActivity < quietWindowMs) {
                const nextDelay = Math.max(delayMs, quietWindowMs - elapsedSinceActivity, 140);
                this.scheduleCompactChromeBuildPendingClear(nextDelay);
                return;
            }
            this.compactChromePagedBuildPending = false;
            this.compactChromeAwaitingCalibration = false;
            this.compactChromeInitialTotalPages = 0;
            this.compactChromeLatestTotalPages = 0;
            this.compactChromeBuildLastActivityAt = 0;
            this.clearCompactChromeStatusHold();
        }, Math.max(120, Math.round(Number(delayMs || 0) || 0)));
    }

    noteCompactChromeTotalPages() {
        if (!this.compactChromePagedBuildPending || !this.isPagedMode)
            return;

        const total = Math.max(1, Number(this.totalPages || 1) || 1);
        if (!this.compactChromeInitialTotalPages)
            this.compactChromeInitialTotalPages = total;
        this.compactChromeLatestTotalPages = total;

        if (total !== this.compactChromeInitialTotalPages) {
            this.compactChromeAwaitingCalibration = false;
            this.touchCompactChromeBuildActivity();
            this.scheduleCompactChromeBuildPendingClear(540);
        }
    }

    captureStableReaderStatus(force = false) {
        if (!force && this.stableReaderStatus.ready && (this.layoutRefreshing || this.isPagedBuildPending))
            return;

        const pageMeta = this.showPagedPageCounter ? `${this.currentPage}/${this.totalPages}` : '';
        const sectionMeta = (this.isCompactLayout ? '' : this.currentSectionTitle);
        this.stableReaderStatus = {
            ready: true,
            progressPercent: this.progressPercent,
            currentPage: this.currentPage,
            totalPages: this.totalPages,
            pageMeta,
            sectionMeta,
        };
    }

    beginLayoutRefresh(reason = 'default') {
        if (this.layoutRefreshTimer) {
            clearTimeout(this.layoutRefreshTimer);
            this.layoutRefreshTimer = null;
        }
        this.captureStableReaderStatus();
        this.layoutRefreshStartedAt = Date.now();
        this.layoutRefreshReason = String(reason || 'default');
        this.layoutRefreshing = true;
    }

    runAfterLayoutRefreshPaint(callback = () => {}) {
        this.$nextTick(() => {
            setTimeout(() => {
                let finished = false;
                let fallbackTimer = 0;
                const finish = () => {
                    if (finished)
                        return;
                    finished = true;
                    if (fallbackTimer) {
                        clearTimeout(fallbackTimer);
                        fallbackTimer = 0;
                    }
                    callback();
                };

                fallbackTimer = setTimeout(finish, (this.readerDebugEnabled ? 34 : 68));
                requestAnimationFrame(() => {
                    requestAnimationFrame(finish);
                });
            }, 0);
        });
    }

    afterLayoutRefreshPaint() {
        return new Promise((resolve) => {
            this.runAfterLayoutRefreshPaint(resolve);
        });
    }

    waitForAnimationFrames(count = 2) {
        const frames = Math.max(1, Math.round(Number(count || 0) || 0));
        return new Promise((resolve) => {
            const step = (remaining) => {
                if (remaining <= 0) {
                    resolve();
                    return;
                }

                let finished = false;
                let fallbackTimer = 0;
                const next = () => {
                    if (finished)
                        return;
                    finished = true;
                    if (fallbackTimer) {
                        clearTimeout(fallbackTimer);
                        fallbackTimer = 0;
                    }
                    step(remaining - 1);
                };

                fallbackTimer = setTimeout(next, (this.readerDebugEnabled ? 24 : 34));
                requestAnimationFrame(next);
            };
            step(frames);
        });
    }

    getPagedStageRect() {
        const stage = (this.$refs ? this.$refs.pageStage : null);
        if (!stage || typeof stage.getBoundingClientRect !== 'function')
            return {width: 0, height: 0};

        const rect = stage.getBoundingClientRect();
        return {
            width: Math.max(0, Math.round(rect.width || stage.clientWidth || 0)),
            height: Math.max(0, Math.round(rect.height || stage.clientHeight || 0)),
        };
    }

    syncMeasureHostToStage() {
        const measureHost = (this.$refs ? this.$refs.pageMeasure : null);
        const stageRect = this.getPagedStageRect();
        if (!measureHost || !stageRect.width || !stageRect.height)
            return stageRect;

        measureHost.style.width = `${stageRect.width}px`;
        measureHost.style.maxWidth = `${stageRect.width}px`;
        measureHost.style.minWidth = `${stageRect.width}px`;
        measureHost.style.height = `${stageRect.height}px`;
        measureHost.style.minHeight = `${stageRect.height}px`;
        return stageRect;
    }

    async waitForStablePagedStage(requiredStableFrames = 2, timeoutMs = 480) {
        if (!this.isPagedMode)
            return {width: 0, height: 0};

        const startedAt = Date.now();
        let stableFrames = 0;
        let lastKey = '';
        let lastRect = {width: 0, height: 0};

        while ((Date.now() - startedAt) < timeoutMs) {
            await this.$nextTick();
            await this.waitForAnimationFrames(1);

            lastRect = this.syncMeasureHostToStage();
            const nextKey = `${lastRect.width}x${lastRect.height}`;
            if (lastRect.width > 0 && lastRect.height > 0) {
                stableFrames = (nextKey === lastKey ? stableFrames + 1 : 1);
                lastKey = nextKey;
                if (stableFrames >= Math.max(1, requiredStableFrames))
                    return lastRect;
            }
        }

        return lastRect;
    }

    endLayoutRefresh(delayMs = 180) {
        if (this.layoutRefreshTimer)
            clearTimeout(this.layoutRefreshTimer);

        const elapsed = Math.max(0, Date.now() - (this.layoutRefreshStartedAt || 0));
        const minVisibleMs = 260;
        const waitMs = Math.max(delayMs, minVisibleMs - elapsed);
        this.layoutRefreshTimer = setTimeout(() => {
            this.layoutRefreshTimer = null;
            this.layoutRefreshing = false;
            this.layoutRefreshReason = '';
            this.captureStableReaderStatus(true);
            if (this.isPagedMode && this.bottomClipCalibrationPending)
                this.scheduleBottomClipCalibration();
        }, Math.max(0, waitMs));
    }

    scheduleImageLayoutRefresh() {
        if (typeof window === 'undefined')
            return;

        this.beginLayoutRefresh();
        this.requestBottomClipCalibration();
        if (this.imageLayoutFrame)
            cancelAnimationFrame(this.imageLayoutFrame);

        this.imageLayoutFrame = requestAnimationFrame(() => {
            this.imageLayoutFrame = 0;
            this.runAfterLayoutRefreshPaint(() => {
                this.updateScrollerViewport();
                this.endLayoutRefresh(160);
            });
        });
    }

    scheduleBottomClipCalibration() {
        if (!this.isPagedMode || typeof window === 'undefined')
            return;

        this.bottomClipCalibrationPending = false;
        if (this.compactChromePagedBuildPending) {
            this.compactChromeAwaitingCalibration = true;
            this.touchCompactChromeBuildActivity();
            this.beginCompactChromeStatusHold(4200);
        }
        if (this.bottomCalibrationFrame)
            cancelAnimationFrame(this.bottomCalibrationFrame);

        this.bottomCalibrationFrame = requestAnimationFrame(() => {
            this.bottomCalibrationFrame = requestAnimationFrame(() => {
                this.bottomCalibrationFrame = 0;
                this.calibrateDynamicBottomClipCompensation();
            });
        });
    }

    measureLivePageContentBottom(sheet, html) {
        if (!sheet || !html || typeof window === 'undefined')
            return null;

        const sheetRect = sheet.getBoundingClientRect();
        const sheetStyle = window.getComputedStyle(sheet);
        const paddingBottom = parseFloat(sheetStyle.paddingBottom || '0') || 0;
        const safeBottom = sheetRect.bottom - paddingBottom - 2;

        let maxBottom = -Infinity;

        const walker = document.createTreeWalker(
            html,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (node.nodeType === Node.TEXT_NODE)
                        return (String(node.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT);
                    return NodeFilter.FILTER_ACCEPT;
                },
            },
        );

        let current = walker.currentNode;
        while (current) {
            let rects = [];
            if (current.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(current);
                rects = Array.from(range.getClientRects());
                if (typeof range.detach === 'function')
                    range.detach();
            } else if (typeof current.getClientRects === 'function') {
                rects = Array.from(current.getClientRects());
            }

            for (const rect of rects) {
                if (!rect || rect.height <= 0)
                    continue;
                maxBottom = Math.max(maxBottom, rect.bottom);
            }

            current = walker.nextNode();
        }

        if (!Number.isFinite(maxBottom))
            maxBottom = sheetRect.top;

        return {
            sheetRect,
            safeBottom,
            textBottom: maxBottom,
            overflow: Math.ceil(maxBottom - safeBottom),
        };
    }

    getActiveLivePagedSheet() {
        const readerBody = (this.$refs ? this.$refs.readerBody : null);
        if (!readerBody || typeof window === 'undefined')
            return null;

        const liveSheets = Array.from(readerBody.querySelectorAll('.reader-page-sheet--live'));
        if (!liveSheets.length)
            return null;

        const currentIndex = String(this.currentPageIndex);
        const matchingSheets = liveSheets.filter((sheet) => String(sheet.dataset.pageIndex || '') === currentIndex);
        const candidates = (matchingSheets.length ? matchingSheets : liveSheets);

        let bestSheet = null;
        let bestScore = -Infinity;

        for (const sheet of candidates) {
            const rect = (typeof sheet.getBoundingClientRect === 'function' ? sheet.getBoundingClientRect() : null);
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;

            const style = window.getComputedStyle(sheet);
            if (style.display === 'none' || style.visibility === 'hidden')
                continue;

            const opacity = Math.max(0, Math.min(1, parseFloat(style.opacity || '1') || 0));
            const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth || rect.right) - Math.max(rect.left, 0));
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight || rect.bottom) - Math.max(rect.top, 0));
            const visibleArea = visibleWidth * visibleHeight;
            const score = visibleArea * Math.max(0.15, opacity);

            if (score > bestScore) {
                bestScore = score;
                bestSheet = sheet;
            }
        }

        return (bestSheet || candidates[0] || null);
    }

    calibrateDynamicBottomClipCompensation() {
        if (!this.isPagedMode || typeof window === 'undefined' || typeof document === 'undefined')
            return;
        if (this.layoutRefreshing) {
            this.bottomClipCalibrationPending = true;
            if (this.bottomCalibrationFrame)
                cancelAnimationFrame(this.bottomCalibrationFrame);
            this.bottomCalibrationFrame = requestAnimationFrame(() => {
                this.bottomCalibrationFrame = 0;
                this.scheduleBottomClipCalibration();
            });
            return;
        }

        const sheet = this.getActiveLivePagedSheet();
        const html = (sheet ? sheet.querySelector('.reader-html') : null);
        if (!sheet || !html || typeof document.createRange !== 'function')
            return;

        const metrics = this.measureLivePageContentBottom(sheet, html);
        if (!metrics)
            return;

        this.readerDebug = Object.assign({}, this.readerDebug, {
            liveSheetHeight: Math.round(metrics.sheetRect.height),
            liveSafeBottom: Math.round(metrics.safeBottom),
            liveTextBottom: Math.round(metrics.textBottom),
            liveOverflowPx: Math.round(metrics.overflow),
        });

        const overflow = metrics.overflow;
        const currentDynamic = this.currentDynamicBottomClipCompensation;
        const measureOverflow = Number(this.readerDebug.measureOverflowPx || 0) || 0;
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.2, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const linePx = Math.max(18, Math.round(fontSize * lineHeight));
        const increaseTolerance = Math.max(6, Math.round(linePx * 0.22));
        const maxDynamicCompensation = Math.max(
            linePx * 2,
            Math.round(linePx * (this.isCompactLayout ? 3.8 : 4.6)),
        );

        if (overflow > increaseTolerance && overflow <= 160) {
            const nextValue = Math.min(maxDynamicCompensation, currentDynamic + overflow + 2);
            if (this.isCompactLayout) {
                if (nextValue === this.dynamicBottomClipCompensationCompact)
                    return;
                this.dynamicBottomClipCompensationCompact = nextValue;
            } else {
                if (nextValue === this.dynamicBottomClipCompensationRegular)
                    return;
                this.dynamicBottomClipCompensationRegular = nextValue;
            }

            this.reflowReaderLayout();
            return;
        }

        // Clamp runaway manual/auto compensation so one bad page does not leave huge gaps everywhere.
        if (currentDynamic > maxDynamicCompensation && measureOverflow > increaseTolerance) {
            if (this.isCompactLayout) {
                this.dynamicBottomClipCompensationCompact = maxDynamicCompensation;
            } else {
                this.dynamicBottomClipCompensationRegular = maxDynamicCompensation;
            }

            this.reflowReaderLayout();
            return;
        }

        if (this.compactChromePagedBuildPending) {
            this.compactChromeAwaitingCalibration = false;
            this.touchCompactChromeBuildActivity();
            this.scheduleCompactChromeBuildPendingClear(720);
        }
    }

    bindReaderImageListeners() {
        if (typeof window === 'undefined' || !this.$refs || !this.$refs.page)
            return;

        const images = Array.from(this.$refs.page.querySelectorAll('img'));
        for (const img of images) {
            if (this.boundReaderImages.has(img))
                continue;

            this.boundReaderImages.add(img);
            if (img.complete)
                continue;

            const handleImageReady = () => {
                this.scheduleImageLayoutRefresh();
            };

            img.addEventListener('load', handleImageReady, {once: true});
            img.addEventListener('error', handleImageReady, {once: true});
        }
    }

    escapeRegExp(value = '') {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    stripHtml(html = '') {
        if (typeof document === 'undefined')
            return String(html || '');

        const host = document.createElement('div');
        host.innerHTML = String(html || '');
        return String(host.textContent || host.innerText || '');
    }

    highlightHtmlMatches(html = '', query = '') {
        const safeQuery = String(query || '').trim();
        if (!safeQuery || typeof document === 'undefined')
            return html;

        const host = document.createElement('div');
        host.innerHTML = String(html || '');
        const pattern = new RegExp(this.escapeRegExp(safeQuery), 'gi');
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const textNodes = [];

        while (walker.nextNode())
            textNodes.push(walker.currentNode);

        for (const textNode of textNodes) {
            const value = String(textNode.nodeValue || '');
            if (!value.trim() || !pattern.test(value))
                continue;

            pattern.lastIndex = 0;
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match = pattern.exec(value);
            while (match) {
                const matchText = match[0];
                const matchIndex = match.index;
                if (matchIndex > lastIndex)
                    fragment.appendChild(document.createTextNode(value.slice(lastIndex, matchIndex)));

                const mark = document.createElement('mark');
                mark.className = 'reader-search-hit';
                mark.textContent = matchText;
                fragment.appendChild(mark);
                lastIndex = matchIndex + matchText.length;
                match = pattern.exec(value);
            }

            if (lastIndex < value.length)
                fragment.appendChild(document.createTextNode(value.slice(lastIndex)));

            if (textNode.parentNode)
                textNode.parentNode.replaceChild(fragment, textNode);
        }

        return host.innerHTML;
    }

    rebuildSearchResults(resetIndex = false) {
        const query = String(this.searchQuery || '').trim().toLowerCase();
        if (!query || !this.isPagedMode || !this.pagedPages.length) {
            this.searchResults = [];
            this.currentSearchResultIndex = -1;
            return;
        }

        const results = [];
        for (let index = 0; index < this.pagedPages.length; index += 1) {
            const page = this.pagedPages[index] || {};
            const text = this.stripHtml(page.html || '').toLowerCase();
            if (text.includes(query))
                results.push({pageIndex: index});
        }

        this.searchResults = results;
        if (!results.length) {
            this.currentSearchResultIndex = -1;
            return;
        }

        if (resetIndex || this.currentSearchResultIndex < 0 || this.currentSearchResultIndex >= results.length) {
            const nearestIndex = results.findIndex((item) => item.pageIndex >= this.currentPageIndex);
            this.currentSearchResultIndex = (nearestIndex >= 0 ? nearestIndex : 0);
            return;
        }

        const activePageIndex = (this.searchResults[this.currentSearchResultIndex] || {}).pageIndex;
        const nextCurrentIndex = results.findIndex((item) => item.pageIndex === activePageIndex);
        this.currentSearchResultIndex = (nextCurrentIndex >= 0 ? nextCurrentIndex : 0);
    }

    handleSearchInput() {
        this.rebuildSearchResults(true);
        if (this.hasSearchResults)
            this.goToSearchResult(this.currentSearchResultIndex, false);
    }

    goToSearchResult(index = 0, save = true) {
        if (!this.hasSearchResults)
            return;

        const safeIndex = Math.max(0, Math.min(this.searchResults.length - 1, index));
        this.currentSearchResultIndex = safeIndex;
        const result = this.searchResults[safeIndex];
        if (!result)
            return;

        this.setCurrentPagedPage(result.pageIndex, save);
    }

    jumpToNextSearchResult() {
        if (!this.hasSearchResults)
            return;

        const nextIndex = (this.currentSearchResultIndex + 1) % this.searchResults.length;
        this.goToSearchResult(nextIndex, true);
    }

    jumpToPrevSearchResult() {
        if (!this.hasSearchResults)
            return;

        const nextIndex = (this.currentSearchResultIndex <= 0 ? this.searchResults.length - 1 : this.currentSearchResultIndex - 1);
        this.goToSearchResult(nextIndex, true);
    }

    reflowReaderLayout() {
        if (this.isPagedMode && this.isCompactLayout && this.compactChromeHidden) {
            this.compactChromePagedBuildPending = true;
            this.beginCompactChromeStatusHold(5200);
            this.touchCompactChromeBuildActivity();
        }
        this.beginLayoutRefresh();
        this.restorePending = true;
        this.clearSnapTimer();
        this.requestBottomClipCalibration();
        this.runAfterLayoutRefreshPaint(() => {
            this.updateScrollerViewport();
            requestAnimationFrame(() => {
                this.restoreProgress();
                this.endLayoutRefresh(220);
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

    getPagedMeasureAvailableHeight(measureHost) {
        if (!measureHost || typeof window === 'undefined' || !window.getComputedStyle)
            return 0;

        const measureHtml = measureHost.querySelector('.reader-html');
        const htmlRect = (measureHtml && typeof measureHtml.getBoundingClientRect === 'function'
            ? measureHtml.getBoundingClientRect()
            : {height: 0});
        const hostStyle = window.getComputedStyle(measureHost);
        const htmlStyle = (measureHtml ? window.getComputedStyle(measureHtml) : null);
        const syncedStageRect = this.syncMeasureHostToStage();
        const hostRect = (typeof measureHost.getBoundingClientRect === 'function'
            ? measureHost.getBoundingClientRect()
            : {height: 0});
        const hostPaddingTop = parseFloat(hostStyle.paddingTop || '0') || 0;
        const hostPaddingBottom = parseFloat(hostStyle.paddingBottom || '0') || 0;
        const htmlPaddingTop = parseFloat((htmlStyle && htmlStyle.paddingTop) || '0') || 0;
        const htmlPaddingBottom = parseFloat((htmlStyle && htmlStyle.paddingBottom) || '0') || 0;
        const directHtmlHeight = Math.max(
            0,
            Math.round(Math.max(
                (measureHtml && measureHtml.clientHeight) || 0,
                htmlRect.height || 0,
            )),
        );
        const pageOuterHeight = Math.max(
            0,
            Math.round(Math.max(
                syncedStageRect.height || 0,
                hostRect.height || 0,
                this.pageMinHeight || 0,
                measureHost.clientHeight || 0,
            )),
        );
        const fallbackHeight = Math.max(0, Math.round(
            pageOuterHeight
            - hostPaddingTop
            - hostPaddingBottom
            - htmlPaddingTop
            - htmlPaddingBottom
        ));
        const availableHeight = (directHtmlHeight || fallbackHeight);

        this.readerDebug = Object.assign({}, this.readerDebug, {
            measureAvailableHeight: Math.round(availableHeight),
            baseBottomClipCompensation: 0,
            totalBottomClipCompensation: 0,
            pagedContentSafetyInset: 0,
        });
        return availableHeight;
    }

    get pagedContentSafetyInset() {
        const fontSize = Math.max(14, Number(this.activePreferences.fontSize || 18) || 18);
        const lineHeight = Math.max(1.2, Number(this.activePreferences.lineHeight || 1.7) || 1.7);
        const reserveLines = (this.isCompactLayout ? 2.65 : 3.0);
        const reserve = Math.ceil(fontSize * lineHeight * reserveLines);
        return Math.max((this.isCompactLayout ? 44 : 52), reserve);
    }

    measureElementContentInnerHeight(contentNode) {
        if (!contentNode || typeof window === 'undefined' || !window.getComputedStyle)
            return 0;

        const rootRect = contentNode.getBoundingClientRect();
        let maxBottom = Math.max(
            rootRect.top,
            rootRect.top + (contentNode.scrollHeight || 0),
            rootRect.top + (contentNode.offsetHeight || 0),
            rootRect.top + (contentNode.clientHeight || 0),
        );

        for (const node of Array.from(contentNode.querySelectorAll('*'))) {
            if (!node || typeof node.getBoundingClientRect !== 'function')
                continue;

            const rect = node.getBoundingClientRect();
            if (!rect || rect.height <= 0)
                continue;

            maxBottom = Math.max(maxBottom, rect.bottom);
        }

        const lastElement = this.getDeepestLastElement(contentNode);
        if (lastElement && typeof lastElement.getBoundingClientRect === 'function') {
            const lastRect = lastElement.getBoundingClientRect();
            if (lastRect && lastRect.height > 0) {
                const lastStyle = window.getComputedStyle(lastElement);
                const marginBottom = parseFloat(lastStyle.marginBottom || '0') || 0;
                maxBottom = Math.max(maxBottom, lastRect.bottom + Math.max(0, marginBottom));
            }
        }

        return Math.max(0, Math.ceil(maxBottom - rootRect.top));
    }

    measureContentInnerHeight(contentNode) {
        if (!contentNode || typeof window === 'undefined' || !window.getComputedStyle || typeof document.createRange !== 'function')
            return 0;

        const isMeasureNode = !!(contentNode.closest && contentNode.closest('.reader-page-sheet--measure'));
        if (isMeasureNode)
            return this.measureElementContentInnerHeight(contentNode);

        const rootRect = contentNode.getBoundingClientRect();
        let maxBottom = rootRect.top;

        const walker = document.createTreeWalker(
            contentNode,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (node.nodeType === Node.TEXT_NODE)
                        return (String(node.nodeValue || '').trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT);
                    return NodeFilter.FILTER_ACCEPT;
                },
            },
        );

        let current = walker.currentNode;
        while (current) {
            let rects = [];
            if (current.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                range.selectNodeContents(current);
                rects = Array.from(range.getClientRects());
                if (typeof range.detach === 'function')
                    range.detach();
            } else if (typeof current.getClientRects === 'function') {
                rects = Array.from(current.getClientRects());
            }

            for (const rect of rects) {
                if (!rect || rect.height <= 0)
                    continue;
                maxBottom = Math.max(maxBottom, rect.bottom);
            }

            current = walker.nextNode();
        }

        const lastElement = this.getDeepestLastElement(contentNode);
        if (lastElement && typeof lastElement.getBoundingClientRect === 'function') {
            const lastRect = lastElement.getBoundingClientRect();
            if (lastRect && lastRect.height > 0) {
                const lastStyle = window.getComputedStyle(lastElement);
                const marginBottom = parseFloat(lastStyle.marginBottom || '0') || 0;
                maxBottom = Math.max(maxBottom, lastRect.bottom + Math.max(0, marginBottom));
            }
        }

        return Math.max(0, Math.ceil(maxBottom - rootRect.top));
    }

    doesPagedMeasureOverflow(measureHost, measureHtml = null) {
        if (!measureHost)
            return false;

        const availableHeight = this.getPagedMeasureAvailableHeight(measureHost);
        if (!availableHeight)
            return false;

        const htmlNode = (measureHtml || measureHost.querySelector('.reader-html') || null);
        const contentNode = (
            (htmlNode && htmlNode.querySelector('.reader-page-content'))
            || htmlNode
            || measureHost
        );
        const measuredHeight = Math.max(
            contentNode.scrollHeight || 0,
            contentNode.offsetHeight || 0,
            contentNode.clientHeight || 0,
            this.measureContentInnerHeight(contentNode),
        );

        this.readerDebug = Object.assign({}, this.readerDebug, {
            measureContentHeight: Math.round(measuredHeight),
            measureOverflowPx: Math.round(measuredHeight - availableHeight),
        });

        return measuredHeight > Math.max(0, availableHeight - 12);
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
        return `
            <div class="reader-page-content">
                ${parts.join('')}
                <div class="reader-page-spacer" aria-hidden="true"></div>
            </div>
        `;
    }

    splitTextIntoReadableChunks(text = '', targetLength = 420, minChunkLength = 140) {
        const source = String(text || '').replace(/\s+/g, ' ').trim();
        if (!source)
            return [];

        const sentenceParts = source.match(/[^.!?…]+(?:[.!?…]+|$)/g) || [source];
        const chunks = [];
        let current = '';

        const pushCurrent = () => {
            const value = String(current || '').trim();
            if (value)
                chunks.push(value);
            current = '';
        };

        const pushWords = (sentence = '') => {
            const words = String(sentence || '').trim().split(/\s+/).filter(Boolean);
            if (!words.length)
                return;

            let part = '';
            for (const word of words) {
                const candidate = (part ? `${part} ${word}` : word);
                if (part && candidate.length > targetLength) {
                    chunks.push(part);
                    part = word;
                } else {
                    part = candidate;
                }
            }

            if (part)
                chunks.push(part);
        };

        for (const sentence of sentenceParts.map((item) => String(item || '').trim()).filter(Boolean)) {
            const candidate = (current ? `${current} ${sentence}` : sentence);
            if (!current || candidate.length <= targetLength) {
                current = candidate;
                continue;
            }

            if (current.length >= minChunkLength) {
                pushCurrent();
            }

            if (sentence.length > targetLength) {
                if (current)
                    pushCurrent();
                pushWords(sentence);
            } else {
                current = sentence;
            }
        }

        if (current)
            pushCurrent();

        return chunks.filter(Boolean);
    }

    splitOversizedTextElement(root, unit = {}, options = {}) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE)
            return [];

        const tagName = String(root.tagName || '').toLowerCase();
        const className = String(root.className || '');
        const canSplitText = (
            tagName === 'p'
            || tagName === 'blockquote'
            || className.includes('reader-paragraph')
            || className.includes('reader-epigraph')
            || className.includes('reader-cite')
        );
        if (!canSplitText)
            return [];

        const sourceText = String(root.textContent || '').replace(/\s+/g, ' ').trim();
        if (!sourceText)
            return [];

        const measureHost = (this.$refs ? this.$refs.pageMeasure : null);
        const measureHtml = (measureHost ? measureHost.querySelector('.reader-html') : null);
        const baseHtml = (Array.isArray(options.baseHtml) ? options.baseHtml : []).filter(Boolean);
        const allowOverflowFallback = (options.allowOverflowFallback !== false);
        const words = sourceText.split(/\s+/).filter(Boolean);
        if (words.length <= 1)
            return [];

        const fallbackChunks = this.splitTextIntoReadableChunks(sourceText, (this.isCompactLayout ? 220 : 420), (this.isCompactLayout ? 90 : 140));
        if (!measureHost || !measureHtml)
            return this.wrapSplitTextChunks(root, unit, fallbackChunks);

        const chunks = [];
        let start = 0;

        const fits = (end) => {
            const clone = root.cloneNode(false);
            clone.textContent = words.slice(start, end).join(' ');
            measureHtml.innerHTML = this.wrapPagedMeasureHtml(baseHtml.concat(clone.outerHTML));
            return !this.doesPagedMeasureOverflow(measureHost, measureHtml);
        };

        while (start < words.length) {
            let low = start + 1;
            let high = words.length;
            let best = -1;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                if (fits(mid)) {
                    best = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            if (best <= start) {
                if (!allowOverflowFallback)
                    break;
                best = Math.min(words.length, start + 1);
            }

            const chunk = words.slice(start, best).join(' ').trim();
            if (!chunk)
                break;

            chunks.push(chunk);
            start = best;
        }

        measureHtml.innerHTML = '';
        if (chunks.length <= 1)
            return (allowOverflowFallback ? this.wrapSplitTextChunks(root, unit, fallbackChunks) : []);

        return this.wrapSplitTextChunks(root, unit, chunks);
    }

    wrapSplitTextChunks(root, unit = {}, chunks = []) {
        const safeChunks = (Array.isArray(chunks) ? chunks : []).map((item) => String(item || '').trim()).filter(Boolean);
        if (safeChunks.length <= 1)
            return [];

        let first = true;
        return safeChunks.map((chunk) => {
            const clone = root.cloneNode(false);
            clone.textContent = chunk;
            const result = {
                html: clone.outerHTML,
                breakBefore: (first ? !!unit.breakBefore : false),
                sectionId: (first ? String(unit.sectionId || root.id || '').trim() : ''),
            };
            first = false;
            return result;
        }).filter((item) => String(item.html || '').trim());
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
            return this.splitOversizedTextElement(root, unit);

        let first = true;
        const childSplit = childNodes.map((child) => {
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

        return (childSplit.length ? childSplit : this.splitOversizedTextElement(root, unit));
    }

    splitUnitToFitCurrentPage(unit = {}, currentUnits = []) {
        const html = String(unit.html || '').trim();
        if (!html || typeof(document) === 'undefined' || !Array.isArray(currentUnits) || !currentUnits.length)
            return [];

        const host = document.createElement('div');
        host.innerHTML = html;

        if (host.childNodes.length !== 1 || !host.firstChild || host.firstChild.nodeType !== Node.ELEMENT_NODE)
            return [];

        const root = host.firstChild;
        const childNodes = Array.from(root.childNodes || []).filter((child) => (
            child.nodeType !== Node.TEXT_NODE || String(child.textContent || '').trim()
        ));

        if (childNodes.length <= 1) {
            return this.splitOversizedTextElement(root, unit, {
                baseHtml: currentUnits,
                allowOverflowFallback: false,
            });
        }

        let first = true;
        const childSplit = childNodes.map((child) => {
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

        return childSplit;
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
            if (
                element.classList.contains('reader-section')
                || element.classList.contains('reader-section-block')
                || element.classList.contains('reader-notes')
            ) {
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
            const breakBefore = (
                sectionBreak
                || element.classList.contains('reader-section-heading')
            );
            pushUnit(element.outerHTML, {breakBefore, sectionId});
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
            if (this.doesPagedMeasureOverflow(measureHost, measureHtml) && !currentUnits.length) {
                const splitUnits = this.splitOversizedUnit(unit);
                if (splitUnits.length) {
                    queue.splice(index, 1, ...splitUnits);
                    index -= 1;
                    applyUnits([]);
                    continue;
                }
            }

            if (this.doesPagedMeasureOverflow(measureHost, measureHtml) && currentUnits.length) {
                const fitCurrentPageSplit = this.splitUnitToFitCurrentPage(unit, currentUnits);
                if (fitCurrentPageSplit.length) {
                    queue.splice(index, 1, ...fitCurrentPageSplit);
                    index -= 1;
                    applyUnits(currentUnits);
                    continue;
                }

                finalizePage();
                currentPageSectionId = unit.sectionId || activeSectionId || '';
                currentUnits = [unit.html];
                applyUnits(currentUnits);
                if (this.doesPagedMeasureOverflow(measureHost, measureHtml)) {
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
        this.noteCompactChromeTotalPages();
        this.rebuildSearchResults(false);
    }

    async buildPagedPagesChunked(jobId = 0) {
        if (!this.isPagedMode) {
            this.pagedPages = [];
            return;
        }

        const measureHost = this.$refs ? this.$refs.pageMeasure : null;
        if (!measureHost) {
            this.buildPagedPages();
            return;
        }

        const measureHtml = measureHost.querySelector('.reader-html');
        if (!measureHtml) {
            this.buildPagedPages();
            return;
        }

        const queue = this.buildPagedUnits().slice();
        const totalUnits = Math.max(1, queue.length || 1);
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
        const maybeYield = async(index) => {
            if (index <= 0 || index % 18 !== 0)
                return;
            if (jobId && jobId !== this.pagedBuildJobId)
                return;
            const percent = Math.min(99, Math.max(1, Math.round((index / totalUnits) * 100)));
            this.pagedBuildProgressPercent = percent;
            this.loadingMessage = `${this.uiText.loadingPages} ${percent}%`;
            await this.waitForAnimationFrames(1);
        };

        this.pagedBuildInProgress = true;
        this.pagedBuildNeedsRefresh = false;
        this.pagedBuildProgressPercent = 1;
        if (this.compactChromePagedBuildPending)
            this.touchCompactChromeBuildActivity();

        try {
            applyUnits([]);
            for (let index = 0; index < queue.length; index += 1) {
                if (jobId && jobId !== this.pagedBuildJobId)
                    return;

                const unit = queue[index];
                if (unit.sectionId)
                    activeSectionId = unit.sectionId;
                if (unit.breakBefore && currentUnits.length) {
                    finalizePage();
                    currentPageSectionId = unit.sectionId || activeSectionId || '';
                }

                const candidateUnits = currentUnits.concat(unit.html);
                applyUnits(candidateUnits);
                if (this.doesPagedMeasureOverflow(measureHost, measureHtml) && !currentUnits.length) {
                    const splitUnits = this.splitOversizedUnit(unit);
                    if (splitUnits.length) {
                        queue.splice(index, 1, ...splitUnits);
                        index -= 1;
                        applyUnits([]);
                        await maybeYield(index + 1);
                        continue;
                    }
                }

                if (this.doesPagedMeasureOverflow(measureHost, measureHtml) && currentUnits.length) {
                    const fitCurrentPageSplit = this.splitUnitToFitCurrentPage(unit, currentUnits);
                    if (fitCurrentPageSplit.length) {
                        queue.splice(index, 1, ...fitCurrentPageSplit);
                        index -= 1;
                        applyUnits(currentUnits);
                        await maybeYield(index + 1);
                        continue;
                    }

                    finalizePage();
                    currentPageSectionId = unit.sectionId || activeSectionId || '';
                    currentUnits = [unit.html];
                    applyUnits(currentUnits);
                    if (this.doesPagedMeasureOverflow(measureHost, measureHtml)) {
                        const splitUnits = this.splitOversizedUnit(unit);
                        if (splitUnits.length) {
                            currentUnits = [];
                            applyUnits([]);
                            queue.splice(index, 1, ...splitUnits);
                            index -= 1;
                            await maybeYield(index + 1);
                            continue;
                        }
                    }
                } else {
                    currentUnits = candidateUnits;
                    if (unit.sectionId && !currentPageSectionId)
                        currentPageSectionId = unit.sectionId;
                }

                await maybeYield(index + 1);
            }

            finalizePage();
            this.pagedPages = (pages.length ? pages : [{html: this.readerHtml || '', sectionId: ''}]);
            this.currentPageIndex = Math.max(0, Math.min(this.pagedPages.length - 1, this.currentPageIndex));
            this.noteCompactChromeTotalPages();
            this.rebuildSearchResults(false);
        } finally {
            this.pagedBuildInProgress = false;
            this.pagedBuildProgressPercent = 0;
            if (this.compactChromePagedBuildPending)
                this.touchCompactChromeBuildActivity();
            if (this.pagedBuildNeedsRefresh) {
                this.pagedBuildNeedsRefresh = false;
                this.updateScrollerViewport();
            } else if (this.compactChromePagedBuildPending) {
                this.scheduleCompactChromeBuildPendingClear();
            }
        }
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
                parts.push(`<section class="reader-notes"><h2>Примечания</h2>${html}</section>`);
            else
                parts.push(`<section class="reader-section">${html}</section>`);
        }

        return parts.join('\n');
    }

    createFb2Parser(source = '') {
        if (source instanceof Fb2Parser)
            return source;

        if (Array.isArray(source))
            return new Fb2Parser(source);

        if (source && typeof source === 'object') {
            if (Array.isArray(source.rawNodes))
                return new Fb2Parser(source.rawNodes);

            // Some API responses already send parsed FictionBook root nodes.
            if (source[0] && Array.isArray(source[0]))
                return new Fb2Parser(source);
        }

        const parser = new Fb2Parser();
        parser.fromString(String(source || ''), {
            lowerCase: true,
        });
        return parser;
    }

    async applyReaderDocumentSource({
        book = {},
        fb2 = '',
        cover = '',
        contents = [],
        stateResponse = {},
    } = {}) {
        const parser = this.createFb2Parser(fb2);
        const fb2Info = parser.bookInfo();
        const authorFallback = ((fb2Info.titleInfo && fb2Info.titleInfo.author) ? fb2Info.titleInfo.author.join(', ') : '');

        this.title = book.title || (fb2Info.titleInfo && fb2Info.titleInfo.bookTitle) || 'Без названия';
        this.authorLine = book.author || authorFallback;
        this.seriesLine = (book.series ? `${book.series}${book.serno ? ` #${book.serno}` : ''}` : '');
        this.coverSrc = cover || '';
        this.contents = this.sanitizeContents(contents || []);
        this.readerHtml = this.buildReaderHtml(parser);

        if (stateResponse && stateResponse.preferences)
            this.preferences = Object.assign({}, this.preferences, stateResponse.preferences || {});
        this.progress = Object.assign({percent: 0, sectionId: '', updatedAt: ''}, (stateResponse && stateResponse.progress) || {});
        this.bookmarks = Array.isArray(stateResponse && stateResponse.bookmarks) ? stateResponse.bookmarks : [];
        this.currentSectionId = String(this.progress.sectionId || '').trim();
        this.restorePending = true;
        this.currentPageIndex = 0;

        this.$root.setAppTitle(this.title);
    }

    async loadReader() {
        if (!this.bookUid && !this.isStandaloneMode) {
            await this.loadReaderHome();
            return;
        }

        const api = this.$root.api;
        if (!api && !this.isStandaloneMode) {
            this.error = 'Читалка ещё не готова. Попробуйте открыть книгу ещё раз.';
            return;
        }

        this.loading = true;
        this.loadingMessage = this.uiText.loadingFetch;
        this.bookPreparing = false;
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
        this.helpDialogOpen = false;
        this.bookmarkComposerOpen = false;
        this.inlineContentsVisible = false;
        this.chromeHidden = false;
        this.readerMetaExpanded = false;

        try {
            await this.afterLayoutRefreshPaint();

        this.loadingMessage = this.uiText.loadingParse;
        await this.afterLayoutRefreshPaint();

        if (this.isStandaloneMode) {
                const source = (this.standaloneSource || {});
                this.bookInfo = {
                    book: Object.assign({}, source.book || {}, {
                        title: source.title || (source.book && source.book.title) || '',
                        author: source.author || (source.book && source.book.author) || '',
                        series: source.series || (source.book && source.book.series) || '',
                        serno: source.serno || (source.book && source.book.serno) || 0,
                    }),
                    fb2: source.fb2 || '',
                    cover: source.cover || '',
                    contents: Array.isArray(source.contents) ? source.contents : [],
                };

                await this.applyReaderDocumentSource({
                    book: this.bookInfo.book || {},
                    fb2: this.bookInfo.fb2 || '',
                    cover: this.bookInfo.cover || '',
                    contents: this.bookInfo.contents || [],
                    stateResponse: (source.stateResponse || {}),
                });
            } else {
                const [bookResponse, stateResponseRaw] = await Promise.all([
                    api.getBookInfo(this.bookUid),
                    api.getReaderState(this.bookUid).catch(() => ({preferences: {}, progress: {}})),
                ]);
                const stateResponse = (stateResponseRaw || {preferences: {}, progress: {}});

                this.bookInfo = (bookResponse ? bookResponse.bookInfo : null);
                const info = (this.bookInfo || {});
                if (!info.fb2)
                    throw new Error('Встроенная читалка пока поддерживает только FB2.');

                await this.applyReaderDocumentSource({
                    book: (info.book || {}),
                    fb2: info.fb2 || '',
                    cover: info.cover || '',
                    contents: info.contents || [],
                    stateResponse,
                });
            }

            this.loading = false;
            this.bookPreparing = true;
            this.loadingMessage = this.uiText.loadingPages;
            this.pagedPages = [];
            this.currentPageIndex = 0;

            await this.$nextTick();
            await this.afterLayoutRefreshPaint();
            if (this.isPagedMode) {
                await this.waitForStablePagedStage();
                this.scrollerViewportWidth = ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientWidth) || 0);
                this.scrollerViewportHeight = ((this.$refs && this.$refs.scroller && this.$refs.scroller.clientHeight) || 0);
                this.pagedBuildJobId += 1;
                await this.buildPagedPagesChunked(this.pagedBuildJobId);
                this.syncPagedProgress(false);
                if (this.bottomClipCalibrationPending)
                    this.scheduleBottomClipCalibration();
            } else {
                this.updateScrollerViewport();
                await this.waitForAnimationFrames(2);
            }
            this.attachScrollerObserver();
            await this.waitForAnimationFrames(2);
            this.restoreProgress();
            await this.waitForAnimationFrames(2);
        } catch (e) {
            this.error = e.message;
        } finally {
            this.loading = false;
            this.bookPreparing = false;
            this.loadingMessage = '';
            this.captureStableReaderStatus(true);
            this.$nextTick(() => this.notifyReaderProfileWarning());
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
        if (this.isPagedMode) {
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

        this.toggleCompactChromeVisibility();
    }

    handleReaderWheel(event) {
        if (!this.isPagedMode || !this.$refs.scroller || !event)
            return;

        const delta = (this.isHorizontalPaged ? (Number(event.deltaX || 0) || Number(event.deltaY || 0)) : Number(event.deltaY || 0));
        if (Math.abs(delta) < 8)
            return;

        event.preventDefault();
        this.goToRelativePage(delta > 0 ? 1 : -1);
    }

    handleGlobalKeydown(event) {
        if (!event)
            return;

        const target = event.target;
        const tagName = String((target && target.tagName) || '').toLowerCase();
        const isTypingField = (
            (target && target.isContentEditable)
            || ['input', 'textarea', 'select'].includes(tagName)
            || (target && target.closest && target.closest('.q-dialog'))
        );
        if (isTypingField)
            return;

        if (!this.$route || !String(this.$route.path || '').startsWith('/reader'))
            return;

        const key = String(event.key || '');
        if (key === 'Escape') {
            if (this.searchDialogOpen) {
                this.searchDialogOpen = false;
                return;
            }
            if (this.helpDialogOpen) {
                this.helpDialogOpen = false;
                return;
            }
            return;
        }

        if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'f' && this.isPagedMode) {
            event.preventDefault();
            this.searchDialogOpen = true;
            return;
        }

        if (key === '?' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            this.toggleHelpDialog();
            return;
        }

        if (!this.isPagedMode || this.helpDialogOpen)
            return;

        const nextKeys = ['ArrowRight', 'ArrowDown', 'PageDown'];
        const prevKeys = ['ArrowLeft', 'ArrowUp', 'PageUp'];

        if (nextKeys.includes(key) || (key === ' ' && !event.shiftKey)) {
            event.preventDefault();
            this.goToRelativePage(1);
            return;
        }

        if (prevKeys.includes(key) || (key === ' ' && event.shiftKey)) {
            event.preventDefault();
            this.goToRelativePage(-1);
        }
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
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        if (absX < threshold && absY < threshold)
            return;

        if (absX >= absY) {
            this.goToRelativePage(deltaX < 0 ? 1 : -1);
            return;
        }

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
        if (!await this.ensureReaderProfileReady())
            return;

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
            this.$root.stdDialog.alert(e.message, 'Ошибка');
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
        if (this.readerProfileWarningVisible)
            return;

        const api = this.$root.api;
        if (!api)
            return;

        await api.updateReaderProgress(this.bookUid, {
            percent: Number(this.progress.percent || 0) || 0,
            sectionId: this.currentSectionId || '',
        });
    }

    async toggleCurrentBookRead() {
        if (!this.bookUid)
            return;

        if (!await this.ensureReaderProfileReady())
            return;

        const api = this.$root.api;
        if (!api)
            return;

        const read = !this.isBookMarkedRead;
        try {
            await api.markReaderBooksRead([this.bookUid], read);
            this.progress = Object.assign({}, this.progress, {
                percent: (read ? 1 : 0),
                sectionId: '',
                updatedAt: new Date().toISOString(),
            });
            this.currentSectionId = '';
            this.$root.notify.success(read ? this.uiText.readMarked : this.uiText.readUnmarked, '', this.readerNotifyOptions);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.uiText.error);
        }
    }

    async persistPreferences() {
        const api = this.$root.api;
        if (!api)
            return;

        await api.updateReaderPreferences(this.preferences);
    }

    notifyReaderProfileWarning() {
        if (!this.readerProfileWarningVisible || !this.$root.notify)
            return;

        const key = this.readerProfileWarningKey;
        if (!key || this.profileWarningNotifiedKey === key)
            return;

        this.profileWarningNotifiedKey = key;
        this.$root.notify.warn(this.readerProfileWarningTitle, this.readerProfileWarningCaption, Object.assign({}, this.readerNotifyOptions, {
            icon: 'la la-user-lock',
        }));
    }

    async promptReaderProfileLogin() {
        const api = this.$root.api;
        const target = this.currentSelectedProfile;
        if (!api)
            return false;

        try {
            await api.showProfileLoginDialog(target && !this.config.profileAuthorized && !target.anonymousProfile ? target.login || '' : '');
            this.profileWarningNotifiedKey = '';
            if (!this.bookUid && !this.isStandaloneMode)
                await this.loadReaderHome();
            return true;
        } catch (e) {
            const message = e.message || String(e);
            if (message !== '\u0412\u0445\u043e\u0434 \u0432 \u043f\u0440\u043e\u0444\u0438\u043b\u044c \u043e\u0442\u043c\u0435\u043d\u0451\u043d')
                this.$root.stdDialog.alert(message, this.uiText.error);
            return false;
        }
    }

    async handleReaderProfileChipClick() {
        if (this.readerProfileCanLogin)
            await this.promptReaderProfileLogin();
    }

    async ensureReaderProfileReady() {
        if (!this.readerProfileWarningVisible)
            return true;

        this.notifyReaderProfileWarning();
        if (this.readerProfileCanLogin)
            return await this.promptReaderProfileLogin();

        return false;
    }

    flushProgress() {
        if (this.saveProgressDebounced && this.saveProgressDebounced.flush)
            this.saveProgressDebounced.flush();
    }

    async setTheme(theme) {
        if (!this.bookUid) {
            this.preferences = Object.assign({}, this.preferences, {theme});
            this.savePreferencesDebounced();
            return;
        }

        const previousSignature = this.layoutSignatureForPreferences(this.activePreferences);
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.preferences = Object.assign({}, this.preferences, {theme});
        this.savePreferencesDebounced();
        const nextSignature = this.layoutSignatureForPreferences(this.getActivePreferencesForTheme(theme, this.preferences));
        if (previousSignature !== nextSignature) {
            this.reflowReaderLayout();
        } else {
            this.endLayoutRefresh(140);
        }
    }

    async changeFontSize(delta) {
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.updateActivePreferences({
            fontSize: Math.max(14, Math.min(30, this.activePreferences.fontSize + delta)),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    async setFontFamily(fontFamily) {
        const next = this.normalizeFontFamily(fontFamily);
        if (next === this.selectedFontFamily)
            return;

        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.updateActivePreferences({fontFamily: next});
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    async changeContentWidth(delta) {
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
        this.updateActivePreferences({
            contentWidth: Math.max(560, Math.min(1200, this.activePreferences.contentWidth + delta)),
        });
        this.savePreferencesDebounced();
        this.reflowReaderLayout();
    }

    async changeLineHeight(delta) {
        this.beginLayoutRefresh();
        await this.afterLayoutRefreshPaint();
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
    contain: layout paint;
}

.reader-profile-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 220px;
    min-width: 0;
    max-width: 240px;
    min-height: 34px;
    padding: 6px 10px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: var(--reader-surface);
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 800;
    line-height: 1.1;
    cursor: default;
}

.reader-profile-chip span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.reader-profile-chip--authorized {
    border-color: color-mix(in srgb, var(--reader-text) 18%, var(--reader-border));
    color: var(--reader-muted);
    background: color-mix(in srgb, var(--reader-surface) 86%, var(--reader-surface-2) 14%);
}

.reader-profile-chip--open {
    border-color: color-mix(in srgb, #60a5fa 30%, var(--reader-border));
    color: color-mix(in srgb, #60a5fa 72%, var(--reader-text));
}

.reader-profile-chip--locked {
    border-color: color-mix(in srgb, var(--reader-accent) 42%, var(--reader-border));
    color: var(--reader-accent);
    cursor: pointer;
}

.reader-profile-chip--missing {
    color: var(--reader-muted);
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

.reader-font-select {
    min-width: 138px;
    max-width: 168px;
    background: var(--reader-surface-2);
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    color: var(--reader-text);
}

.reader-font-select :deep(.q-field__control) {
    min-height: 34px;
    height: 34px;
    border-radius: 999px;
    color: var(--reader-text);
    padding: 0 10px 0 14px;
    background: transparent;
}

.reader-font-select :deep(.q-field__control::before),
.reader-font-select :deep(.q-field__control::after) {
    display: none;
}

.reader-font-select :deep(.q-field__native),
.reader-font-select :deep(.q-field__append) {
    min-height: 34px;
    color: var(--reader-text);
}

.reader-font-select :deep(.q-field__native) {
    font-size: 13px;
    font-weight: 700;
    line-height: 34px;
    padding: 0;
}

.reader-font-select :deep(.q-field__append) {
    padding-left: 6px;
}

:global(.reader-font-menu) {
    border: 1px solid var(--reader-border);
    border-radius: 14px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.28);
    overflow: hidden;
}

:global(.reader-font-menu .q-item) {
    min-height: 34px;
    color: var(--reader-text);
    font-size: 13px;
    font-weight: 700;
}

:global(.reader-font-menu .q-item.q-item--active),
:global(.reader-font-menu .q-item--active .q-item__label) {
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

.reader-home {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 28px;
}

.reader-home-panel {
    width: min(980px, 100%);
    margin: 0 auto;
}

.reader-home-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
    margin-bottom: 18px;
}

.reader-home-kicker {
    margin-bottom: 6px;
    color: var(--reader-accent);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
}

.reader-home-title {
    margin: 0;
    color: var(--reader-text);
    font-size: 30px;
    line-height: 1.15;
}

.reader-home-subtitle {
    margin-top: 8px;
    color: var(--reader-muted);
    font-size: 14px;
}

.reader-home-actions,
.reader-home-book-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
}

.reader-home-theme {
    flex: 0 0 auto;
    justify-content: center;
    margin-left: auto;
}

.reader-home-theme :deep(.q-btn) {
    min-height: 28px;
    padding: 4px 9px;
    font-size: 13px;
    line-height: 1.15;
}

.reader-home-tools {
    display: grid;
    gap: 12px;
    margin-bottom: 14px;
}

.reader-home-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.reader-home-tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 8px 12px;
    border: 1px solid var(--reader-border);
    border-radius: 8px;
    background: var(--reader-surface);
    color: var(--reader-muted);
    font-weight: 800;
    cursor: pointer;
}

.reader-home-tab span {
    min-width: 24px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--reader-surface-2);
    color: var(--reader-text);
    text-align: center;
    font-size: 12px;
}

.reader-home-tab.is-active {
    border-color: var(--reader-accent);
    color: var(--reader-accent);
}

.reader-home-search-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
    gap: 10px;
    align-items: center;
}

.reader-home-search :deep(.q-field__control),
.reader-home-sort :deep(.q-field__control) {
    min-height: 42px;
    border-radius: 8px;
    background: var(--reader-surface);
    color: var(--reader-text);
}

.reader-home-list {
    display: grid;
    gap: 10px;
}

.reader-home-book {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 14px;
    align-items: center;
    padding: 14px;
    border: 1px solid var(--reader-border);
    border-radius: 8px;
    background: var(--reader-surface);
}

.reader-home-book-title {
    color: var(--reader-text);
    font-size: 16px;
    font-weight: 800;
    line-height: 1.25;
}

.reader-home-book-meta {
    margin-top: 4px;
    color: var(--reader-muted);
    font-size: 13px;
}

.reader-home-progress {
    display: grid;
    grid-template-columns: minmax(120px, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin-top: 10px;
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 800;
}

.reader-home-progress-bar {
    height: 6px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--reader-surface-2);
}

.reader-home-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--reader-accent);
}

.reader-home-state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px;
    border: 1px solid var(--reader-border);
    border-radius: 8px;
    background: var(--reader-surface);
    color: var(--reader-muted);
}

.reader-home-state--empty {
    align-items: flex-start;
}

.reader-home-empty-title {
    color: var(--reader-text);
    font-weight: 800;
}

.reader-home-empty-text {
    margin-top: 4px;
    font-size: 13px;
}

.reader-reflow-indicator {
    position: absolute;
    inset: 0;
    z-index: 18;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    pointer-events: none;
}

.reader-reflow-indicator--compact {
    z-index: 20;
    background: color-mix(in srgb, var(--reader-bg) 18%, transparent);
    backdrop-filter: blur(2px);
}

.reader-reflow-indicator--strong {
    z-index: 22;
    background: color-mix(in srgb, var(--reader-bg) 48%, transparent);
    backdrop-filter: blur(4px);
}

.reader-reflow-card {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--reader-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    color: var(--reader-text);
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.14);
    backdrop-filter: blur(10px);
    font-size: 13px;
    font-weight: 700;
}

.reader-reflow-card--compact {
    padding: 12px 16px;
    box-shadow: 0 18px 36px rgba(0, 0, 0, 0.18);
}

.reader-reflow-card--loading {
    padding: 14px 18px;
    border-radius: 18px;
    box-shadow: 0 20px 44px rgba(0, 0, 0, 0.18);
    font-size: 14px;
}

.reader-reflow-fade-enter-active,
.reader-reflow-fade-leave-active {
    transition: opacity 0.18s ease, transform 0.18s ease;
}

.reader-reflow-fade-enter-from,
.reader-reflow-fade-leave-to {
    opacity: 0;
    transform: translateY(6px);
}

.reader-debug-panel {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 26;
    width: min(92vw, 320px);
    padding: 10px 12px;
    border: 1px solid rgba(255, 120, 120, 0.45);
    border-radius: 14px;
    background: rgba(25, 12, 12, 0.88);
    color: #ffe9d8;
    box-shadow: 0 14px 30px rgba(0, 0, 0, 0.24);
    font: 12px/1.35 Consolas, "Courier New", monospace;
    pointer-events: none;
}

.reader-debug-title {
    margin-bottom: 6px;
    color: #ffb38a;
    font-weight: 700;
}

.reader-debug-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    pointer-events: auto;
}

.reader-debug-btn {
    padding: 4px 8px;
    border: 1px solid rgba(255, 179, 138, 0.35);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: #ffe9d8;
    font: inherit;
    cursor: pointer;
}

.reader-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
}

.reader-scroll--paged {
    overflow: clip;
    overflow: hidden;
    scroll-behavior: smooth;
    overscroll-behavior: contain;
    touch-action: none;
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

.reader-shell--paged {
    min-height: 100%;
    box-sizing: border-box;
    overflow: hidden;
    padding-bottom: 0;
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
    font-family: var(--reader-font-family);
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
    height: auto;
    max-height: none;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    overflow: visible;
}

.reader-body--paged .reader-html {
    display: block;
    height: auto;
    max-height: none;
    overflow: hidden;
}

.reader-page-sheet {
    display: flex;
    flex-direction: column;
}

.reader-page-sheet .reader-html {
    flex: 1 1 auto;
    min-height: 0;
    box-sizing: border-box;
    overflow: hidden;
    padding-bottom: 0;
}

.reader-page-sheet .reader-html :deep(.reader-page-content) {
    display: flow-root;
    min-height: 0;
    padding-bottom: 0;
    box-sizing: border-box;
}

.reader-page-sheet .reader-html :deep(.reader-page-spacer) {
    height: 0;
    pointer-events: none;
}

.reader-body--paged .reader-html > .reader-page-content > :first-child {
    margin-top: 0;
}

.reader-body--paged .reader-html > .reader-page-content > :last-child {
    margin-bottom: 0;
}

.reader-pages {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--reader-page-gap);
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    height: var(--reader-page-min-height);
    overflow: visible;
}

.reader-page-stage {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: min(100%, var(--reader-page-frame-width));
    max-width: var(--reader-page-frame-width);
    height: var(--reader-page-min-height);
    overflow: visible;
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
    height: var(--reader-page-min-height);
    padding: var(--reader-page-padding);
    box-sizing: border-box;
    border: 1px solid var(--reader-border);
    border-radius: 26px;
    background: color-mix(in srgb, var(--reader-surface) 94%, transparent);
    box-shadow: none;
    background-clip: padding-box;
    scroll-snap-align: start;
    scroll-snap-stop: always;
    overflow: hidden;
    contain: layout paint style;
}

.reader-page-sheet--horizontal {
    flex: 0 0 var(--reader-page-frame-width);
    width: var(--reader-page-frame-width);
    max-width: var(--reader-page-frame-width);
    height: var(--reader-page-min-height);
}

.reader-page-sheet--live {
    position: absolute;
    inset: 0;
    margin: auto;
}

.reader-page-sheet--measure {
    position: absolute;
    inset: 0;
    margin: auto;
    visibility: hidden;
    pointer-events: none;
    z-index: -1;
    filter: none;
}

.reader-page-slide-x-forward-enter-active,
.reader-page-slide-x-forward-leave-active,
.reader-page-slide-x-back-enter-active,
.reader-page-slide-x-back-leave-active,
.reader-page-slide-y-forward-enter-active,
.reader-page-slide-y-forward-leave-active,
.reader-page-slide-y-back-enter-active,
.reader-page-slide-y-back-leave-active {
    position: absolute;
    inset: 0;
    transition: opacity var(--reader-page-transition-duration, 180ms) ease, transform var(--reader-page-transition-duration, 180ms) cubic-bezier(.2, .75, .3, 1);
    will-change: opacity, transform;
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-y-forward-enter-from,
.reader-page-slide-x-back-enter-from,
.reader-page-slide-y-back-enter-from,
.reader-page-slide-x-forward-leave-to,
.reader-page-slide-y-forward-leave-to,
.reader-page-slide-x-back-leave-to,
.reader-page-slide-y-back-leave-to {
    opacity: var(--reader-page-enter-opacity, 0);
    transform: scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-x-forward-enter-from,
.reader-page-slide-x-back-leave-to {
    transform: translateX(var(--reader-page-shift-x, 10px)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-x-back-enter-from,
.reader-page-slide-x-forward-leave-to {
    transform: translateX(calc(var(--reader-page-shift-x, 10px) * -1)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-y-forward-enter-from,
.reader-page-slide-y-back-leave-to {
    transform: translateY(var(--reader-page-shift-y, 8px)) scale(var(--reader-page-enter-scale, 1));
}

.reader-page-slide-y-back-enter-from,
.reader-page-slide-y-forward-leave-to {
    transform: translateY(calc(var(--reader-page-shift-y, 8px) * -1)) scale(var(--reader-page-enter-scale, 1));
}

.reader-body--paged .reader-section,
.reader-body--paged .reader-notes,
.reader-body--paged .reader-progress-bar,
.reader-body--paged .reader-contents-inline,
.reader-body--paged .reader-series,
.reader-body--paged .reader-heading,
.reader-body--paged .reader-subheading,
.reader-body--paged .reader-image-block,
.reader-body--paged .reader-cover-box {
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

.reader-body--paged .reader-cover {
    width: auto;
    max-width: min(100%, 320px);
    max-height: var(--reader-page-media-max-height);
    object-fit: contain;
}

.reader-body--paged .reader-html :deep(img),
.reader-body--paged .reader-inline-image {
    width: auto;
    max-width: 100%;
    max-height: var(--reader-page-media-max-height);
    object-fit: contain;
}

.reader-notes {
    margin-top: 2.5em;
    padding-top: 1.5em;
    border-top: 1px solid var(--reader-border);
}

.reader-mobile-footer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 8px calc(8px + env(safe-area-inset-bottom));
    border-top: 0;
    background: linear-gradient(to top, color-mix(in srgb, var(--reader-bg) 96%, transparent), transparent);
}

.reader-mobile-bar {
    display: flex;
    gap: 6px;
    padding: 4px;
    border: 1px solid var(--reader-border);
    border-radius: 22px;
    background: color-mix(in srgb, var(--reader-surface) 88%, var(--reader-bg) 12%);
    box-shadow:
        0 16px 34px rgba(0, 0, 0, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.3);
    backdrop-filter: blur(12px);
}

.reader-mobile-btn {
    flex: 1 1 0;
    min-height: 64px;
    padding: 6px 4px 8px;
    border: 1px solid color-mix(in srgb, var(--reader-border) 78%, var(--reader-surface) 22%);
    border-radius: 16px;
    background:
        linear-gradient(
            to bottom,
            color-mix(in srgb, var(--reader-surface) 92%, white 8%) 0%,
            color-mix(in srgb, var(--reader-surface-2) 92%, var(--reader-surface) 8%) 100%
        );
    color: var(--reader-text);
    box-shadow:
        0 6px 14px rgba(0, 0, 0, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.34);
}

.reader-mobile-btn :deep(.q-btn__content) {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 100%;
    line-height: 1.08;
}

.reader-mobile-btn :deep(.q-icon) {
    font-size: 19px;
}

.reader-mobile-btn :deep(.block) {
    display: block;
    max-width: 100%;
    font-size: 10.5px;
    font-weight: 760;
    letter-spacing: 0.01em;
    text-align: center;
    text-wrap: balance;
    white-space: normal;
}

.reader-mobile-btn.is-active {
    border-color: color-mix(in srgb, var(--reader-accent) 36%, var(--reader-border));
    background:
        linear-gradient(
            to bottom,
            color-mix(in srgb, var(--reader-accent-soft) 82%, var(--reader-surface) 18%) 0%,
            color-mix(in srgb, var(--reader-accent-soft) 58%, var(--reader-surface-2) 42%) 100%
        );
    color: var(--reader-accent);
    box-shadow:
        0 8px 18px rgba(0, 0, 0, 0.12),
        inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.reader-status-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 4px 10px;
    border: 1px solid color-mix(in srgb, var(--reader-border) 72%, var(--reader-surface-2));
    border-radius: 999px;
    background: color-mix(in srgb, var(--reader-surface-2) 96%, transparent);
    color: var(--reader-muted);
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 8px 16px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(10px);
}

.reader-status-bar-spinner {
    flex: 0 0 auto;
    opacity: 0.9;
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

.reader-help-intro {
    margin-bottom: 12px;
    color: var(--reader-muted);
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

.reader-help-item {
    padding: 12px 14px;
    border: 1px solid var(--reader-border);
    border-radius: 16px;
    background: color-mix(in srgb, var(--reader-surface-2) 86%, transparent);
    line-height: 1.45;
}

.reader-help-item + .reader-help-item {
    margin-top: 10px;
}

.reader-search-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
}

.reader-search-meta {
    margin-top: 6px;
    color: var(--reader-muted);
    font-size: 12px;
}

.reader-html :deep(.reader-search-hit) {
    padding: 0.04em 0.14em;
    border-radius: 0.28em;
    background: color-mix(in srgb, var(--reader-accent) 28%, transparent);
    color: inherit;
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

.reader-theme-eink .reader-inline-image,
.reader-theme-eink .reader-page-sheet,
.reader-theme-eink .reader-mobile-bar,
.reader-theme-eink .reader-status-bar,
.reader-theme-eink .reader-dialog,
.reader-theme-eink .reader-overlay-panel {
    box-shadow: none;
}

.reader-theme-eink .reader-mobile-bar,
.reader-theme-eink .reader-status-bar {
    backdrop-filter: none;
}

.reader-theme-sepia .reader-mobile-footer,
.reader-theme-light .reader-mobile-footer {
    background:
        linear-gradient(
            to top,
            color-mix(in srgb, var(--reader-bg) 90%, var(--reader-surface-2) 10%) 0%,
            color-mix(in srgb, var(--reader-bg) 84%, var(--reader-surface) 16%) 28%,
            color-mix(in srgb, var(--reader-bg) 90%, transparent) 62%,
            transparent 100%
        );
    gap: 10px;
    padding-top: 14px;
    box-shadow:
        inset 0 1px 0 color-mix(in srgb, var(--reader-text) 12%, transparent),
        inset 0 12px 24px color-mix(in srgb, var(--reader-bg) 82%, transparent);
}

.reader-theme-sepia .reader-status-bar,
.reader-theme-light .reader-status-bar {
    border-color: color-mix(in srgb, var(--reader-border) 70%, var(--reader-text) 30%);
    box-shadow:
        0 14px 24px rgba(0, 0, 0, 0.16),
        0 -2px 8px rgba(255, 255, 255, 0.22),
        inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.reader-theme-sepia .reader-mobile-bar,
.reader-theme-light .reader-mobile-bar {
    border-color: color-mix(in srgb, var(--reader-border) 82%, var(--reader-text) 18%);
    box-shadow:
        0 16px 30px rgba(0, 0, 0, 0.16),
        0 -1px 0 rgba(255, 255, 255, 0.24),
        inset 0 1px 0 rgba(255, 255, 255, 0.42);
}

.reader-theme-sepia .reader-mobile-footer {
    background:
        linear-gradient(
            to top,
            color-mix(in srgb, var(--reader-bg) 84%, var(--reader-surface-2) 16%) 0%,
            color-mix(in srgb, var(--reader-bg) 76%, var(--reader-surface) 24%) 28%,
            color-mix(in srgb, var(--reader-bg) 88%, transparent) 62%,
            transparent 100%
        );
}

.reader-theme-sepia .reader-status-bar {
    color: color-mix(in srgb, var(--reader-text) 88%, var(--reader-muted));
    background: color-mix(in srgb, var(--reader-surface-2) 82%, var(--reader-text) 18%);
}

.reader-theme-sepia .reader-mobile-bar {
    background: color-mix(in srgb, var(--reader-surface) 84%, var(--reader-bg) 16%);
}

.reader-theme-light .reader-status-bar {
    color: color-mix(in srgb, var(--reader-text) 84%, var(--reader-muted));
    background: color-mix(in srgb, var(--reader-surface-2) 84%, var(--reader-text) 16%);
}

.reader-theme-light .reader-mobile-bar {
    background: color-mix(in srgb, var(--reader-surface) 86%, var(--reader-bg) 14%);
}

.reader-theme-eink .reader-page-slide-x-forward-enter-active,
.reader-theme-eink .reader-page-slide-x-forward-leave-active,
.reader-theme-eink .reader-page-slide-x-back-enter-active,
.reader-theme-eink .reader-page-slide-x-back-leave-active,
.reader-theme-eink .reader-page-slide-y-forward-enter-active,
.reader-theme-eink .reader-page-slide-y-forward-leave-active,
.reader-theme-eink .reader-page-slide-y-back-enter-active,
.reader-theme-eink .reader-page-slide-y-back-leave-active {
    transition: none;
    will-change: auto;
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
        align-items: center;
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
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .reader-book-title {
        font-size: 13px;
        line-height: 1.12;
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
        display: none;
    }

    .reader-profile-chip {
        flex: 0 0 auto;
        max-width: 94px;
        min-height: 32px;
        padding: 5px 8px;
        gap: 5px;
        font-size: 11px;
        border-radius: 12px;
    }

    .reader-profile-chip :deep(.q-icon) {
        font-size: 16px;
    }

    .reader-profile-chip span {
        max-width: 58px;
    }

    .reader-home {
        padding: 16px 10px 22px;
    }

    .reader-home-head,
    .reader-home-book {
        grid-template-columns: 1fr;
        display: grid;
    }

    .reader-home-actions,
    .reader-home-book-actions {
        align-items: stretch;
    }

    .reader-home-search-row {
        grid-template-columns: 1fr;
    }

    .reader-home-actions .q-btn,
    .reader-home-book-actions .q-btn {
        flex: 1 1 150px;
    }

    .reader-home-theme :deep(.q-btn) {
        flex: 0 0 auto;
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
    .reader-stepper,
    .reader-font-select {
        width: 100%;
        max-width: none;
        justify-content: center;
        border-radius: 14px;
        min-height: 44px;
    }

    .reader-font-select :deep(.q-field__control) {
        min-height: 44px;
        height: 44px;
    }

    .reader-progress-text {
        width: 100%;
        min-width: 0;
        text-align: left;
        padding-left: 4px;
    }

    .reader-shell {
        padding: 2px 2px 10px;
    }

    .reader-body--paged {
        width: 100%;
        border-radius: 20px;
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.12);
    }

    .reader-pages {
        margin-bottom: 12px;
    }

    .reader-page-sheet,
    .reader-page-sheet--horizontal {
        width: 100%;
        max-width: 100%;
        border-radius: 16px;
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
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .reader-mobile-bar--with-contents {
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .reader-mobile-btn {
        min-height: 60px;
        border-radius: 15px;
    }

    .reader-mobile-btn :deep(.q-icon) {
        font-size: 18px;
    }

    .reader-mobile-btn :deep(.block) {
        font-size: 10px;
    }

    .reader-html :deep(p),
    .reader-paragraph {
        text-align: left;
    }
}
</style>
