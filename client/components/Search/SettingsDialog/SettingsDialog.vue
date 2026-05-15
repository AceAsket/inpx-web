<template>
    <Dialog ref="dialog" v-model="dialogVisible">
        <template #header>
            <div class="row items-center" style="font-size: 110%">
                <q-icon class="q-mr-sm text-green" name="la la-cog" size="28px"></q-icon>
                Настройки
            </div>
        </template>

        <div class="q-mx-md column settings-dialog-body" style="min-width: 300px; font-size: 120%;">
            <div class="row items-center q-ml-sm">
                <div class="q-mr-sm">
                    Результатов на странице
                </div>
                <q-select
                    v-model="limit"
                    :options="limitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <q-checkbox v-show="config.latestVersion" v-model="showNewReleaseAvailable" size="36px" label="Уведомлять о выходе новой версии" />
            <q-checkbox v-model="downloadAsZip" size="36px" label="Скачивать книги в виде zip-архива" />
            <q-checkbox v-model="showCounts" size="36px" label="Показывать количество" />
            <q-checkbox v-model="showRates" size="36px" label="Показывать оценки" />
            <q-checkbox v-model="showInfo" size="36px" label="Показывать кнопку «Инфо»" />
            <q-checkbox v-model="showGenres" size="36px" label="Показывать жанры" />
            <div class="settings-card-view row items-center q-ml-sm q-my-xs">
                <div class="q-mr-sm settings-card-view-label">
                    Вид карточек
                </div>
                <q-btn-toggle
                    v-model="bookCardView"
                    class="settings-card-view-toggle"
                    toggle-color="primary"
                    :options="bookCardViewOptions"
                    push
                    no-caps
                    rounded
                />
            </div>
            <q-checkbox v-model="showDates" size="36px" label="Показывать даты поступления" />
            <q-checkbox v-model="showDeleted" size="36px" label="Показывать удалённые" />
            <q-checkbox v-model="abCacheEnabled" size="36px" label="Кешировать запросы" />
            <q-checkbox v-model="darkTheme" size="36px" label="Ночная тема" />

            <div v-if="discoveryEnabled" class="q-mt-sm q-ml-sm text-weight-medium" style="font-size: 92%;">
                Витрины
            </div>
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryNewest" size="36px" label="Показывать вкладку «Новинки»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryPopular" size="36px" label="Показывать вкладку «Популярное»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryContinueReading" size="36px" label="Показывать полку «Продолжить чтение»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryFromLists" size="36px" label="Показывать полку «Из ваших списков»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnfinishedSeries" size="36px" label="Показывать полку «Незаконченные серии»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoverySimilar" size="36px" label="Показывать полку «Похоже на то, что вы читали»" />
            <q-checkbox v-if="discoveryEnabled" v-model="showDiscoveryUnreadOnly" size="36px" label="Во вкладке «Для вас» показывать только непрочитанное" />
            <q-checkbox v-if="discoveryEnabled" v-model="compactDiscoveryCards" size="36px" label="Использовать компактные карточки в витринах" />
            <q-checkbox v-if="effectiveExternalDiscoveryAvailable" v-model="showDiscoveryExternal" size="36px" label="Показывать вкладку внешнего источника" />

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Лимит «Новинки»</div>
                <q-select
                    v-model="discoveryNewestLimit"
                    :options="discoveryLimitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="discoveryEnabled" class="row items-center q-ml-sm q-mt-sm">
                <div class="q-mr-sm">Лимит «Популярное»</div>
                <q-select
                    v-model="discoveryPopularLimit"
                    :options="discoveryLimitOptions"
                    class="bg-white"
                    dropdown-icon="la la-angle-down la-sm"
                    outlined
                    dense
                    emit-value
                    map-options
                />
            </div>

            <div v-if="discoveryEnabled && canEditExternalDiscovery" class="row items-center q-ml-sm q-mt-sm settings-inline-row">
                <div class="q-mr-sm settings-inline-label">Внешний источник</div>
                <div class="settings-inline-summary text-grey-8">
                    {{ externalDiscoverySummary }}
                </div>
                <q-btn
                    class="q-ml-sm"
                    color="primary"
                    flat
                    dense
                    no-caps
                    icon="la la-sliders-h"
                    @click="discoverySourceDialogVisible = true"
                >
                    Управлять
                </q-btn>
            </div>

            <div v-if="effectiveExternalDiscoveryAvailable && !canEditExternalDiscovery" class="q-ml-sm q-mt-sm text-grey-7" style="font-size: 85%;">
                Внешний источник настраивает администратор профиля.
            </div>
            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" @click="backupExpanded = !backupExpanded">
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ backupUi.title }}</div>
                        <div class="admin-mail-subtitle">{{ backupUi.subtitle }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="backupExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>

                <div v-show="backupExpanded" class="admin-collapse-body">
                    <div class="admin-backup-note">
                        <div>{{ backupUi.fullBackupInfo }}</div>
                        <div>{{ backupUi.settingsBackupInfo }}</div>
                        <div>{{ backupUi.restoreNote }}</div>
                    </div>
                    <div class="admin-backup-actions">
                        <q-btn color="primary" dense no-caps icon="la la-download" :loading="backupLoading" @click="createBackup">
                            {{ backupUi.backup }}
                        </q-btn>
                        <q-btn outline color="primary" dense no-caps icon="la la-file-import" :loading="backupImportLoading" @click="openBackupImport">
                            {{ backupUi.backupImport }}
                        </q-btn>
                        <q-btn outline color="primary" dense no-caps icon="la la-file-export" :loading="settingsExportLoading" @click="exportSettings">
                            {{ backupUi.settings }}
                        </q-btn>
                        <q-btn outline color="primary" dense no-caps icon="la la-file-import" :loading="settingsImportLoading" @click="openSettingsImport">
                            {{ backupUi.settingsImport }}
                        </q-btn>
                        <input
                            ref="settingsImportInput"
                            type="file"
                            accept="application/json,.json"
                            style="display: none"
                            @change="onSettingsImportSelected"
                        />
                        <input
                            ref="backupImportInput"
                            type="file"
                            accept="application/zip,.zip"
                            style="display: none"
                            @change="onBackupImportSelected"
                        />
                    </div>
                </div>
            </div>

            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" @click="toggleAdminExpanded">
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ adminUi.title }}</div>
                        <div class="admin-mail-subtitle">{{ adminUi.subtitle }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="adminExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>

                <div v-show="adminExpanded" class="admin-collapse-body">
                    <div class="admin-toolbar">
                        <q-btn outline color="primary" dense no-caps icon="la la-sync" :loading="adminLoading" @click="loadAdminPanel">
                            {{ adminUi.refresh }}
                        </q-btn>
                        <q-btn outline color="primary" dense no-caps icon="la la-broom" :loading="adminCleanLoading" @click="cleanAdminCache('all')">
                            Очистить оба кэша
                        </q-btn>
                        <q-btn outline color="negative" dense no-caps icon="la la-database" :loading="adminReindexLoading" :disable="adminIndexBusy" @click="reindexAdmin">
                            {{ adminUi.reindex }}
                        </q-btn>
                    </div>

                    <div v-if="adminIndexStatusVisible" class="admin-index-status" :class="{'admin-index-status--busy': adminIndexBusy}">
                        <q-spinner v-if="adminIndexBusy" color="primary" size="22px" />
                        <q-icon v-else name="la la-check-circle" size="22px" />
                        <div class="admin-index-status-copy">
                            <div class="admin-index-status-title">{{ adminIndexStatusTitle }}</div>
                            <div class="admin-index-status-text">{{ adminIndexStatusText }}</div>
                            <q-linear-progress v-if="adminIndexBusy" rounded size="6px" :value="adminIndexProgress" color="primary" />
                        </div>
                    </div>

                    <div class="admin-dashboard-grid">
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.books }}</div>
                            <div class="admin-stat-value">{{ adminStat('bookCountAll') }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.authors }}</div>
                            <div class="admin-stat-value">{{ adminStat('authorCountAll') }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.series }}</div>
                            <div class="admin-stat-value">{{ adminStat('seriesCount') }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.uptime }}</div>
                            <div class="admin-stat-value">{{ adminUptime }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.memory }}</div>
                            <div class="admin-stat-value">{{ formatBytes(adminDashboard.memory && adminDashboard.memory.rss) }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.dbSize }}</div>
                            <div class="admin-stat-value">{{ formatBytes(adminDashboard.sizes && adminDashboard.sizes.db && adminDashboard.sizes.db.size) }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.bookCache }}</div>
                            <div class="admin-stat-value">{{ formatBytes(adminDashboard.sizes && adminDashboard.sizes.bookCache && adminDashboard.sizes.bookCache.size) }}</div>
                            <div class="admin-stat-hint">{{ adminCacheLimitText('book') }}</div>
                        </div>
                        <div class="admin-stat">
                            <div class="admin-stat-label">{{ adminUi.coverCache }}</div>
                            <div class="admin-stat-value">{{ formatBytes(adminDashboard.sizes && adminDashboard.sizes.coverCache && adminDashboard.sizes.coverCache.size) }}</div>
                            <div class="admin-stat-hint">{{ adminCacheLimitText('cover') }}</div>
                        </div>
                    </div>

                    <div class="admin-subsection">
                        <div class="admin-subsection-head">
                            <div>
                                <div class="admin-mail-title">Ротация кэша</div>
                                <div class="admin-mail-subtitle">Лимиты задаются в мегабайтах. Плановая ротация запускается в выбранное время по локальным часам сервера.</div>
                            </div>
                            <q-btn outline color="primary" dense no-caps icon="la la-save" :loading="adminCacheSaveLoading" @click="saveAdminCacheSettings">
                                Сохранить
                            </q-btn>
                        </div>
                        <div class="admin-cache-settings-grid">
                            <q-input v-model.number="adminCacheSettings.bookCacheSizeMb" outlined dense type="number" min="1" label="Книжный кэш, MB" />
                            <q-input v-model.number="adminCacheSettings.coverCacheSizeMb" outlined dense type="number" min="1" label="Кэш обложек, MB" />
                            <q-checkbox class="admin-cache-enabled-toggle" v-model="adminCacheSettings.cacheCleanEnabled" size="32px" label="Плановая ротация" />
                            <q-select v-model="adminCacheSettings.cacheCleanFrequency" :options="adminCacheFrequencyOptions" outlined dense emit-value map-options label="Периодичность" :disable="!adminCacheSettings.cacheCleanEnabled" />
                            <q-select v-if="adminCacheSettings.cacheCleanFrequency === 'weekly'" v-model="adminCacheSettings.cacheCleanWeekDay" :options="adminCacheWeekDayOptions" outlined dense emit-value map-options label="День недели" :disable="!adminCacheSettings.cacheCleanEnabled" />
                            <q-select v-if="adminCacheSettings.cacheCleanFrequency === 'monthly'" v-model="adminCacheSettings.cacheCleanMonthDay" :options="adminCacheMonthDayOptions" outlined dense emit-value map-options label="Число месяца" :disable="!adminCacheSettings.cacheCleanEnabled" />
                            <q-input class="admin-cache-time-input" v-model="adminCacheSettings.cacheCleanTime" outlined dense type="time" label="Время запуска" hint="По времени сервера" persistent-hint :disable="!adminCacheSettings.cacheCleanEnabled || adminCacheSettings.cacheCleanFrequency === 'advanced'" />
                            <q-input v-model.number="adminCacheSettings.cacheCleanTargetPercent" outlined dense type="number" min="10" max="100" label="Цель после чистки, %" />
                        </div>
                        <div class="admin-cache-actions">
                            <q-btn outline color="primary" dense no-caps icon="la la-book" :loading="adminCleanBookCacheLoading" @click="cleanAdminCache('book')">
                                Очистить книжный кэш
                            </q-btn>
                            <q-btn outline color="primary" dense no-caps icon="la la-image" :loading="adminCleanCoverCacheLoading" @click="cleanAdminCache('cover')">
                                Очистить кэш обложек
                            </q-btn>
                        </div>
                    </div>

                    <div class="admin-subsection">
                        <div class="admin-subsection-head">
                            <div>
                                <div class="admin-mail-title">{{ adminUi.coverDiagnostics }}</div>
                                <div class="admin-mail-subtitle">{{ adminUi.coverDiagnosticsHint }}</div>
                            </div>
                            <q-btn flat dense no-caps color="negative" icon="la la-broom" :loading="adminBrokenCoversLoading" @click="cleanBrokenCovers">
                                {{ adminUi.cleanBrokenCovers }}
                            </q-btn>
                        </div>
                        <div class="admin-dashboard-grid admin-dashboard-grid--compact">
                            <div class="admin-stat">
                                <div class="admin-stat-label">{{ adminUi.coverCache }}</div>
                                <div class="admin-stat-value">{{ formatBytes(adminCoverStats.size) }}</div>
                            </div>
                            <div class="admin-stat">
                                <div class="admin-stat-label">{{ adminUi.files }}</div>
                                <div class="admin-stat-value">{{ adminCoverStats.files || 0 }}</div>
                            </div>
                            <div class="admin-stat">
                                <div class="admin-stat-label">{{ adminUi.limit }}</div>
                                <div class="admin-stat-value">{{ formatBytes(adminCoverStats.limit) }}</div>
                                <div class="admin-stat-hint">{{ adminCacheTargetText(adminCoverStats.targetSize) }}</div>
                            </div>
                            <div class="admin-stat">
                                <div class="admin-stat-label">{{ adminUi.coverErrors }}</div>
                                <div class="admin-stat-value">{{ adminCoverErrors.length }}</div>
                            </div>
                        </div>
                        <div class="admin-cover-actions">
                            <q-input v-model="adminCoverBookUid" outlined dense clearable :label="adminUi.coverBookUid" />
                            <q-btn color="primary" dense no-caps icon="la la-sync" :loading="adminCoverRebuildLoading" @click="rebuildAdminCover">
                                {{ adminUi.rebuildCover }}
                            </q-btn>
                        </div>
                        <div v-if="adminCoverErrors.length" class="admin-event-list admin-event-list--compact">
                            <div v-for="event in adminCoverErrors" :key="event.id" class="admin-event-row" :class="`admin-event-row--${event.level}`">
                                <div class="admin-event-meta">
                                    {{ formatDateTime(event.time) }} · {{ event.level }} · {{ event.category }}
                                </div>
                                <div class="admin-event-message">{{ event.message }}</div>
                            </div>
                        </div>
                    </div>

                    <div class="admin-subsection">
                        <div class="admin-subsection-head">
                            <div class="admin-mail-title">{{ adminUi.tasks }}</div>
                        </div>
                        <div class="admin-task-list">
                            <div v-for="task in adminTasks" :key="task.id" class="admin-task-row" :class="{'admin-task-row--active': task.active}">
                                <div class="admin-task-main">
                                    <div class="admin-task-title">{{ task.title }}</div>
                                    <div class="admin-task-message">{{ task.message || task.state || adminUi.noTaskMessage }}</div>
                                    <q-linear-progress v-if="task.active" rounded size="6px" :value="taskProgress(task)" color="primary" />
                                    <div v-if="task.lastError" class="admin-task-error">{{ task.lastError }}</div>
                                </div>
                                <q-btn flat dense no-caps :disable="true" icon="la la-ban">
                                    {{ task.cancellable ? adminUi.cancel : adminUi.noCancel }}
                                </q-btn>
                            </div>
                        </div>
                    </div>

                    <div class="admin-subsection">
                        <div class="admin-subsection-head">
                            <div class="admin-mail-title">{{ adminUi.sources }}</div>
                            <q-btn flat dense no-caps color="primary" icon="la la-plus" @click="addAdminSource">
                                {{ adminUi.addSource }}
                            </q-btn>
                        </div>
                        <div class="admin-source-list">
                            <div v-for="(source, index) in adminSources" :key="index" class="admin-source-row">
                                <q-checkbox v-model="source.enabled" size="32px" />
                                <q-input v-model="source.name" outlined dense :label="adminUi.sourceName" />
                                <q-input v-model="source.inpx" outlined dense :label="adminUi.sourceInpx" />
                                <q-input v-model="source.libDir" outlined dense :label="adminUi.sourceLibDir" />
                                <q-btn flat dense round color="primary" icon="la la-search" :loading="source.diagnosticsLoading" @click="diagnoseAdminSource(index)">
                                    <q-tooltip>{{ adminUi.checkSource }}</q-tooltip>
                                </q-btn>
                                <q-btn flat dense round color="negative" icon="la la-trash" @click="removeAdminSource(index)" />
                                <div class="admin-source-diagnostics">
                                    <span :class="source.inpxExists ? 'text-positive' : 'text-negative'">INPX</span>
                                    <span :class="source.libDirExists ? 'text-positive' : 'text-negative'">{{ adminUi.folder }}</span>
                                    <span>{{ adminUi.archives }}: {{ source.archiveCount || 0 }}{{ source.archiveCountTruncated ? '+' : '' }}</span>
                                    <span>covers: {{ source.hasCovers ? 'ok' : '-' }}</span>
                                    <span>etc: {{ source.hasEtc ? 'ok' : '-' }}</span>
                                    <span>images: {{ source.hasImages ? 'ok' : '-' }}</span>
                                    <span>bin: {{ source.hasBin ? 'ok' : '-' }}</span>
                                    <span v-if="source.foundInpx && source.foundInpx.length">{{ adminUi.foundInpx }}: {{ source.foundInpx.length }}</span>
                                </div>
                            </div>
                        </div>
                        <div v-if="adminSourcesChanged || adminSourcesReindexNeeded" class="admin-source-warning">
                            <q-icon name="la la-exclamation-triangle" size="18px" />
                            <span>{{ adminUi.sourcesNeedReindex }}</span>
                        </div>
                        <div class="admin-mail-actions">
                            <q-btn color="primary" dense no-caps icon="la la-save" :loading="adminSourcesLoading" @click="saveAdminSources">
                                {{ adminUi.saveSources }}
                            </q-btn>
                        </div>
                    </div>

                    <div class="admin-subsection">
                        <div class="admin-subsection-head">
                            <div class="admin-mail-title">{{ adminUi.events }}</div>
                            <div class="admin-event-filters">
                                <q-checkbox v-model="adminEventLogEnabled" size="32px" :label="adminUi.eventLogEnabled" @update:model-value="saveAdminEventLog" />
                                <q-select v-model="adminEventLogSize" :options="adminEventLogSizeOptions" outlined dense emit-value map-options @update:model-value="saveAdminEventLog" />
                                <q-select v-model="adminEventLevel" :options="adminEventLevelOptions" outlined dense emit-value map-options @update:model-value="refreshAdminEvents" />
                                <q-select v-model="adminEventCategory" :options="adminEventCategoryOptions" outlined dense emit-value map-options @update:model-value="refreshAdminEvents" />
                                <q-btn flat dense no-caps color="primary" icon="la la-bug" :loading="adminTestEventLoading" @click="addAdminTestEvent">
                                    {{ adminUi.testEvent }}
                                </q-btn>
                            </div>
                        </div>
                        <div v-if="adminEventsLoading" class="admin-empty">{{ adminUi.eventsLoading }}</div>
                        <div v-else-if="!adminEventLogEnabled" class="admin-empty">{{ adminUi.eventsDisabled }}</div>
                        <div v-else-if="!adminEvents.length" class="admin-empty">{{ adminUi.noEvents }}</div>
                        <div v-else class="admin-event-list">
                            <div v-for="event in adminEvents" :key="event.id" class="admin-event-row" :class="`admin-event-row--${event.level}`">
                                <div class="admin-event-meta">
                                    {{ formatDateTime(event.time) }} · {{ event.level }} · {{ event.category }}
                                </div>
                                <div class="admin-event-message">{{ event.message }}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" @click="opdsExpanded = !opdsExpanded">
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ opdsUi.title }}</div>
                        <div class="admin-mail-subtitle">{{ opdsUi.subtitle }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="opdsExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>
                <div v-show="opdsExpanded" class="admin-collapse-body">
                    <div class="admin-mail-grid">
                        <q-checkbox v-model="opdsSettings.enabled" size="34px" :label="opdsUi.enabled" />
                        <q-input v-model="opdsSettings.root" outlined dense clearable :label="opdsUi.root" />
                        <q-input v-model="opdsSettings.user" outlined dense clearable :label="opdsUi.user" />
                        <q-input v-model="opdsSettings.password" outlined dense clearable :type="opdsPasswordVisible ? 'text' : 'password'" :label="opdsUi.password">
                            <template #append>
                                <q-icon :name="opdsPasswordVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="opdsPasswordVisible = !opdsPasswordVisible" />
                            </template>
                        </q-input>
                    </div>
                    <div class="admin-mail-actions">
                        <q-btn color="primary" dense no-caps icon="la la-save" :loading="opdsSaveLoading" @click="saveOpdsSettings">
                            {{ opdsUi.save }}
                        </q-btn>
                    </div>
                </div>
            </div>

            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" @click="mailExpanded = !mailExpanded">
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ mailUi.title }}</div>
                        <div class="admin-mail-subtitle">{{ mailUi.subtitle }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="mailExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>

                <div v-show="mailExpanded" class="admin-collapse-body">
                    <div class="admin-mail-section">
                        <div class="admin-mail-section-head">
                            <q-checkbox v-model="integrations.telegramShareEnabled" size="34px" :label="mailUi.telegramEnabled" />
                            <q-btn flat dense no-caps color="primary" icon="la la-plug" :loading="telegramTestLoading" @click="testTelegram">
                                {{ mailUi.test }}
                            </q-btn>
                        </div>
                        <div class="admin-mail-grid">
                            <q-input v-model="integrations.telegramBotToken" outlined dense clearable :type="telegramTokenVisible ? 'text' : 'password'" :label="mailUi.telegramToken">
                                <template #append>
                                    <q-icon :name="telegramTokenVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="telegramTokenVisible = !telegramTokenVisible" />
                                </template>
                            </q-input>
                            <q-input class="admin-mail-wide" v-model="integrations.telegramCaptionTemplate" outlined dense clearable :label="mailUi.telegramCaption" />
                        </div>
                    </div>

                    <div class="admin-mail-section">
                        <div class="admin-mail-section-head">
                            <q-checkbox v-model="integrations.emailShareEnabled" size="34px" :label="mailUi.smtpEnabled" />
                            <q-btn flat dense no-caps color="primary" icon="la la-plug" :loading="smtpTestLoading" @click="testSmtp">
                                {{ mailUi.test }}
                            </q-btn>
                        </div>
                        <div class="admin-mail-grid">
                            <q-input v-model="integrations.smtpHost" outlined dense clearable :label="mailUi.smtpHost" />
                            <q-input v-model.number="integrations.smtpPort" outlined dense type="number" :label="mailUi.smtpPort" />
                            <q-input v-model="integrations.smtpUser" outlined dense clearable :label="mailUi.smtpUser" />
                            <q-input v-model="integrations.smtpPass" outlined dense clearable :type="smtpPassVisible ? 'text' : 'password'" :label="mailUi.smtpPass">
                                <template #append>
                                    <q-icon :name="smtpPassVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="smtpPassVisible = !smtpPassVisible" />
                                </template>
                            </q-input>
                            <q-input v-model="integrations.emailFrom" outlined dense clearable :label="mailUi.emailFrom" />
                            <q-input v-model="integrations.emailTo" outlined dense clearable :label="mailUi.emailTo" />
                            <q-checkbox v-model="integrations.smtpSecure" size="34px" :label="mailUi.smtpSecure" />
                        </div>
                    </div>

                    <div class="admin-mail-actions">
                        <q-btn color="primary" dense no-caps icon="la la-save" :loading="integrationSaveLoading" @click="saveIntegrations">
                            {{ mailUi.save }}
                        </q-btn>
                    </div>
                </div>
            </div>

            <div class="settings-dialog-actions">
                <q-btn class="settings-ok-btn" color="primary" dense no-caps @click="okClick">
                    OK
                </q-btn>
            </div>
        </div>

        <DiscoverySourceDialog v-if="canEditExternalDiscovery" v-model="discoverySourceDialogVisible" />
    </Dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import Dialog from '../../share/Dialog.vue';
import DiscoverySourceDialog from '../DiscoverySourceDialog/DiscoverySourceDialog.vue';

const componentOptions = {
    components: {
        Dialog,
        DiscoverySourceDialog,
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
        },
        settings() {
            this.loadSettings();
        },
        limit(newValue) {
            this.commit('setSettings', {limit: newValue});
        },
        downloadAsZip(newValue) {
            this.commit('setSettings', {downloadAsZip: newValue});
        },
        showCounts(newValue) {
            this.commit('setSettings', {showCounts: newValue});
        },
        showRates(newValue) {
            this.commit('setSettings', {showRates: newValue});
        },
        showInfo(newValue) {
            this.commit('setSettings', {showInfo: newValue});
        },
        showGenres(newValue) {
            this.commit('setSettings', {showGenres: newValue});
        },
        bookCardView(newValue) {
            this.commit('setSettings', {
                bookCardView: (newValue === 'list' ? 'list' : 'cards'),
            });
        },
        showDates(newValue) {
            this.commit('setSettings', {showDates: newValue});
        },
        showDeleted(newValue) {
            this.commit('setSettings', {showDeleted: newValue});
        },
        abCacheEnabled(newValue) {
            this.commit('setSettings', {abCacheEnabled: newValue});
        },
        showNewReleaseAvailable(newValue) {
            this.commit('setSettings', {showNewReleaseAvailable: newValue});
        },
        darkTheme(newValue) {
            this.commit('setSettings', {darkTheme: newValue});
        },
        showDiscoveryNewest(newValue) {
            this.commit('setSettings', {showDiscoveryNewest: newValue});
        },
        showDiscoveryPopular(newValue) {
            this.commit('setSettings', {showDiscoveryPopular: newValue});
        },
        showDiscoveryContinueReading(newValue) {
            this.commit('setSettings', {showDiscoveryContinueReading: newValue});
        },
        showDiscoveryFromLists(newValue) {
            this.commit('setSettings', {showDiscoveryFromLists: newValue});
        },
        showDiscoveryUnfinishedSeries(newValue) {
            this.commit('setSettings', {showDiscoveryUnfinishedSeries: newValue});
        },
        showDiscoverySimilar(newValue) {
            this.commit('setSettings', {showDiscoverySimilar: newValue});
        },
        showDiscoveryExternal(newValue) {
            this.commit('setSettings', {showDiscoveryExternal: newValue});
        },
        showDiscoveryUnreadOnly(newValue) {
            this.commit('setSettings', {showDiscoveryUnreadOnly: newValue});
        },
        compactDiscoveryCards(newValue) {
            this.commit('setSettings', {compactDiscoveryCards: newValue});
        },
        discoveryNewestLimit(newValue) {
            this.commit('setSettings', {discoveryNewestLimit: newValue});
        },
        discoveryPopularLimit(newValue) {
            this.commit('setSettings', {discoveryPopularLimit: newValue});
        },
    },
};

class SettingsDialog {
    _options = componentOptions;
    _props = {
        modelValue: Boolean,
    };

    dialogVisible = false;
    limit = 20;
    downloadAsZip = false;
    showCounts = true;
    showRates = true;
    showInfo = true;
    showGenres = true;
    bookCardView = 'cards';
    showDates = false;
    showDeleted = false;
    abCacheEnabled = true;
    showNewReleaseAvailable = true;
    darkTheme = false;
    showDiscoveryNewest = true;
    showDiscoveryPopular = true;
    showDiscoveryContinueReading = true;
    showDiscoveryFromLists = true;
    showDiscoveryUnfinishedSeries = true;
    showDiscoverySimilar = true;
    showDiscoveryExternal = true;
    showDiscoveryUnreadOnly = false;
    compactDiscoveryCards = false;
    discoveryNewestLimit = 8;
    discoveryPopularLimit = 8;
    discoveryExternalSource = '';
    discoveryExternalName = '';
    discoveryExternalUrl = '';
    discoverySourceDialogVisible = false;
    integrationSaveLoading = false;
    smtpTestLoading = false;
    telegramTestLoading = false;
    backupLoading = false;
    backupImportLoading = false;
    settingsExportLoading = false;
    settingsImportLoading = false;
    backupExpanded = false;
    opdsSaveLoading = false;
    smtpPassVisible = false;
    telegramTokenVisible = false;
    opdsPasswordVisible = false;
    opdsExpanded = false;
    mailExpanded = false;
    adminExpanded = false;
    adminLoading = false;
    adminCleanLoading = false;
    adminCleanBookCacheLoading = false;
    adminCleanCoverCacheLoading = false;
    adminCacheSaveLoading = false;
    adminReindexLoading = false;
    adminSourcesLoading = false;
    adminBrokenCoversLoading = false;
    adminCoverRebuildLoading = false;
    adminCoverBookUid = '';
    adminTestEventLoading = false;
    adminEventsLoading = false;
    adminEventsRequestId = 0;
    adminSourcesReindexNeeded = false;
    adminReindexInProgress = false;
    adminIndexPollTimer = null;
    adminDashboard = {};
    adminCacheSettings = this.makeDefaultAdminCacheSettings();
    adminSources = [];
    adminEvents = [];
    adminEventLevel = 'all';
    adminEventCategory = 'all';
    adminEventLogEnabled = true;
    adminEventLogSize = 300;
    integrations = this.makeDefaultIntegrations();
    opdsSettings = this.makeDefaultOpdsSettings();
    adminUi = {
        title: 'Администрирование',
        subtitle: 'Состояние библиотеки, источники и журнал событий.',
        refresh: 'Обновить',
        cleanCache: 'Очистить кэш',
        reindex: 'Переиндексировать',
        books: 'Книги',
        authors: 'Авторы',
        series: 'Серии',
        uptime: 'Uptime',
        memory: 'Память',
        dbSize: 'База',
        bookCache: 'Книжный кэш',
        coverCache: 'Кэш обложек',
        files: 'Файлы',
        limit: 'Лимит',
        coverErrors: 'Ошибки',
        coverDiagnostics: 'Обложки',
        coverDiagnosticsHint: 'Размер кэша, последние ошибки и ручное обслуживание обложек.',
        coverBookUid: 'UID книги для пересборки обложки',
        rebuildCover: 'Пересобрать обложку',
        cleanBrokenCovers: 'Очистить битые',
        sources: 'Источники библиотек',
        addSource: 'Добавить',
        saveSources: 'Сохранить источники',
        sourceName: 'Название',
        sourceInpx: 'INPX файл',
        sourceLibDir: 'Папка библиотеки',
        folder: 'Папка',
        archives: 'Архивы',
        foundInpx: 'Найдено .inpx',
        checkSource: 'Проверить источник',
        sourcesNeedReindex: 'Изменения источников применятся после переиндексации.',
        indexNeedsReindex: 'Требуется переиндексация',
        indexReady: 'Индекс готов',
        indexBusy: 'Переиндексация выполняется',
        indexNotReady: 'Индекс не готов',
        indexWaiting: 'Ожидание состояния индекса',
        events: 'События',
        eventLogEnabled: 'Журнал',
        testEvent: 'Тест',
        eventsLoading: 'Загрузка событий...',
        noEvents: 'Событий пока нет.',
        eventsDisabled: 'Журнал событий выключен.',
        savedSources: 'Источники библиотек сохранены',
        cleanStarted: 'Чистка кэша выполнена',
        reindexStarted: 'Переиндексация запущена',
        coverRebuildStarted: 'Кэш обложки сброшен, новая обложка будет собрана при следующем запросе',
        brokenCoversCleaned: 'Битые файлы обложек очищены',
        tasks: 'Задачи и фоновые процессы',
        noTaskMessage: 'Нет активной задачи',
        cancel: 'Отменить',
        noCancel: 'Отмена недоступна',
    };
    adminEventLevelOptions = [
        {label: 'Все уровни', value: 'all'},
        {label: 'Info', value: 'info'},
        {label: 'Warn', value: 'warn'},
        {label: 'Error', value: 'error'},
    ];
    adminEventCategoryOptions = [
        {label: 'Все события', value: 'all'},
        {label: 'Настройки', value: 'settings'},
        {label: 'Источники', value: 'sources'},
        {label: 'Кэш', value: 'cache'},
        {label: 'Обложки', value: 'cover'},
        {label: 'Индекс', value: 'index'},
        {label: 'Отправка', value: 'delivery'},
        {label: 'Система', value: 'system'},
    ];
    adminEventLogSizeOptions = [
        {label: '100', value: 100},
        {label: '300', value: 300},
        {label: '500', value: 500},
        {label: '1000', value: 1000},
    ];
    backupUi = {
        title: 'Резервная копия',
        subtitle: 'Полный бэкап и отдельный экспорт конфигурации.',
        fullBackupInfo: 'Полный ZIP сохраняет состояние сервиса: настройки, secret.key, профили, списки, прогресс чтения, закладки и кэш витрины. Архивы книг, обложки, временные кэши и поисковая БД не входят.',
        settingsBackupInfo: 'JSON настроек нужен только для переноса конфигурации. Пользователи, списки, прогресс и закладки в него не входят.',
        backup: 'Скачать полный бэкап',
        backupImport: 'Восстановить полный ZIP',
        settings: 'Экспорт настроек JSON',
        settingsImport: 'Восстановить настройки JSON',
        restoreNote: 'Восстановление полного ZIP заменяет текущее состояние данными из архива. После восстановления перезапустите контейнер или приложение; если в бэкапе другие источники библиотек, выполните переиндексацию.',
        restoreConfirm: 'Восстановить полный ZIP-бэкап? Текущие настройки, профили, списки, прогресс чтения и закладки будут заменены данными из архива.',
        restored: 'Полный бэкап восстановлен. Перезапустите приложение; если менялись источники библиотек, выполните переиндексацию.',
        ready: 'Резервная копия готова',
    };
    mailUi = {
        title: 'Отправка книг',
        subtitle: 'Настройки SMTP и Telegram доступны только администратору.',
        telegramEnabled: 'Включить Telegram',
        telegramToken: 'Telegram bot token',
        telegramChatId: 'Telegram chat id задаётся в профиле пользователя',
        telegramCaption: 'Подпись Telegram',
        smtpEnabled: 'Включить email',
        smtpHost: 'SMTP host',
        smtpPort: 'SMTP port',
        smtpUser: 'SMTP user',
        smtpPass: 'SMTP password',
        smtpSecure: 'SMTP secure / SSL',
        emailFrom: 'Email from',
        emailTo: 'Email to по умолчанию',
        save: 'Сохранить',
        test: 'Проверить',
        saved: 'Настройки отправки сохранены',
        errorTitle: 'Ошибка',
    };

    opdsUi = {
        title: 'Общий OPDS',
        subtitle: 'Администратор может включить каталог /opds и задать общий Basic Auth. Смена пути каталога применяется после перезапуска.',
        enabled: 'Включить OPDS',
        root: 'Путь каталога',
        user: 'Логин',
        password: 'Пароль',
        save: 'Сохранить',
        saved: 'Настройки OPDS сохранены',
    };

    limitOptions = [
        {label: '10', value: 10},
        {label: '20', value: 20},
        {label: '50', value: 50},
        {label: '100', value: 100},
        {label: '200', value: 200},
        {label: '500', value: 500},
        {label: '1000', value: 1000},
    ];

    discoveryLimitOptions = [
        {label: '4', value: 4},
        {label: '6', value: 6},
        {label: '8', value: 8},
        {label: '10', value: 10},
        {label: '12', value: 12},
        {label: '16', value: 16},
        {label: '20', value: 20},
        {label: '24', value: 24},
    ];

    bookCardViewOptions = [
        {label: 'Карточки', value: 'cards'},
        {label: 'Список', value: 'list'},
    ];

    adminCacheFrequencyOptions = [
        {label: 'Каждый день', value: 'daily'},
        {label: 'Раз в неделю', value: 'weekly'},
        {label: 'Раз в месяц', value: 'monthly'},
        {label: 'Сложное расписание из config.json', value: 'advanced', disable: true},
    ];

    adminCacheWeekDayOptions = [
        {label: 'Понедельник', value: 1},
        {label: 'Вторник', value: 2},
        {label: 'Среда', value: 3},
        {label: 'Четверг', value: 4},
        {label: 'Пятница', value: 5},
        {label: 'Суббота', value: 6},
        {label: 'Воскресенье', value: 0},
    ];

    adminCacheMonthDayOptions = Array.from({length: 31}, (_, index) => ({
        label: `${index + 1} число`,
        value: index + 1,
    }));

    created() {
        this.commit = this.$store.commit;
        this.api = this.$root.api;
        this.loadSettings();
    }

    unmounted() {
        this.stopAdminIndexPolling();
    }

    get config() {
        return this.$store.state.config;
    }

    get settings() {
        return this.$store.state.settings;
    }

    get discoveryConfig() {
        return this.config.discovery || {};
    }

    get discoveryEnabled() {
        return (this.discoveryConfig.enabled !== false);
    }

    get canEditExternalDiscovery() {
        const current = this.config.currentUserProfile || {};
        return !!(this.config.profileAuthorized && current.isAdmin);
    }

    get externalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.discoveryExternalSource && this.discoveryExternalSource !== 'none');
    }

    get effectiveExternalDiscoverySource() {
        const value = String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalSource || this.discoveryConfig.externalSource || '')
                : (this.discoveryConfig.externalSource || ''),
        ).trim().toLowerCase();
        return (value && value !== 'none' ? 'web-page' : 'none');
    }

    get effectiveExternalDiscoveryName() {
        return String(
            this.canEditExternalDiscovery
                ? (this.discoveryExternalName || this.discoveryConfig.externalName || '')
                : (this.discoveryConfig.externalName || ''),
        ).trim();
    }

    get effectiveExternalDiscoveryAvailable() {
        return !!(this.discoveryEnabled && this.effectiveExternalDiscoverySource !== 'none');
    }

    get externalDiscoverySummary() {
        if (!this.effectiveExternalDiscoveryAvailable)
            return 'Не настроен';

        const name = this.effectiveExternalDiscoveryName || 'Внешний источник';
        return `${name} · веб-витрина`;
    }

    makeDefaultIntegrations() {
        return {
            telegramShareEnabled: false,
            telegramBotToken: '',
            telegramChatId: '',
            telegramCaptionTemplate: '${AUTHOR} - ${TITLE}',
            emailShareEnabled: false,
            smtpHost: '',
            smtpPort: 587,
            smtpSecure: false,
            smtpUser: '',
            smtpPass: '',
            emailFrom: '',
            emailTo: '',
        };
    }

    makeDefaultOpdsSettings() {
        return {
            enabled: true,
            root: '/opds',
            user: '',
            password: '',
        };
    }

    loadIntegrations() {
        const source = this.config.adminIntegrations || {};
        this.integrations = Object.assign(this.makeDefaultIntegrations(), source, {
            smtpPort: parseInt(source.smtpPort, 10) || 587,
            telegramBotToken: source.telegramBotToken || (source.telegramBotTokenSet ? '__KEEP__' : ''),
            smtpPass: source.smtpPass || (source.smtpPassSet ? '__KEEP__' : ''),
        });
    }

    loadOpdsSettings() {
        const source = this.config.adminOpds || {};
        this.opdsSettings = Object.assign(this.makeDefaultOpdsSettings(), source, {
            password: source.password || (source.passwordSet ? '__KEEP__' : ''),
        });
    }

    loadSettings() {
        const settings = this.settings;
        const configExternalSource = (String(this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        const hasStoredExternalSettings = !!(
            String(settings.discoveryExternalSource || '').trim()
            || String(settings.discoveryExternalName || '').trim()
            || String(settings.discoveryExternalUrl || '').trim()
        );

        if (!hasStoredExternalSettings && configExternalSource !== 'none') {
            this.commit('setSettings', {
                discoveryExternalSource: configExternalSource,
                discoveryExternalName: String(this.discoveryConfig.externalName || '').trim(),
                discoveryExternalUrl: String(this.discoveryConfig.externalUrl || '').trim(),
                discoveryExternalTtlMinutes: Math.max(1440, parseInt(this.discoveryConfig.externalTtlMinutes, 10) || 1440),
            });
        }

        this.limit = settings.limit;
        this.downloadAsZip = settings.downloadAsZip;
        this.showCounts = settings.showCounts;
        this.showRates = settings.showRates;
        this.showInfo = settings.showInfo;
        this.showGenres = settings.showGenres;
        this.bookCardView = (settings.bookCardView === 'list' ? 'list' : 'cards');
        this.showDates = settings.showDates;
        this.showDeleted = settings.showDeleted;
        this.abCacheEnabled = settings.abCacheEnabled;
        this.showNewReleaseAvailable = settings.showNewReleaseAvailable;
        this.darkTheme = settings.darkTheme;
        this.showDiscoveryNewest = (settings.showDiscoveryNewest !== false);
        this.showDiscoveryPopular = (settings.showDiscoveryPopular !== false);
        this.showDiscoveryContinueReading = (settings.showDiscoveryContinueReading !== false);
        this.showDiscoveryFromLists = (settings.showDiscoveryFromLists !== false);
        this.showDiscoveryUnfinishedSeries = (settings.showDiscoveryUnfinishedSeries !== false);
        this.showDiscoverySimilar = (settings.showDiscoverySimilar !== false);
        this.showDiscoveryExternal = (settings.showDiscoveryExternal !== false);
        this.showDiscoveryUnreadOnly = (settings.showDiscoveryUnreadOnly === true);
        this.compactDiscoveryCards = (settings.compactDiscoveryCards === true);
        this.discoveryNewestLimit = parseInt(settings.discoveryNewestLimit, 10) || 8;
        this.discoveryPopularLimit = parseInt(settings.discoveryPopularLimit, 10) || 8;
        this.discoveryExternalSource = (String(settings.discoveryExternalSource || this.discoveryConfig.externalSource || 'none').trim().toLowerCase() === 'none'
            ? 'none'
            : 'web-page');
        this.discoveryExternalName = String(settings.discoveryExternalName || this.discoveryConfig.externalName || '').trim();
        this.discoveryExternalUrl = String(settings.discoveryExternalUrl || this.discoveryConfig.externalUrl || '').trim();
        this.loadIntegrations();
        this.loadOpdsSettings();
    }

    makeDefaultAdminCacheSettings() {
        return {
            bookCacheSizeMb: 2048,
            coverCacheSizeMb: 512,
            cacheCleanEnabled: true,
            cacheCleanFrequency: 'daily',
            cacheCleanTime: '00:00',
            cacheCleanWeekDay: 1,
            cacheCleanMonthDay: 1,
            cacheCleanAdvancedSchedule: '',
            cacheCleanTargetPercent: 80,
        };
    }

    syncAdminCacheSettings() {
        const limits = (this.adminDashboard && this.adminDashboard.limits) || {};
        const toMb = (value, fallback) => {
            const size = Number(value || 0);
            return Math.max(1, Math.round((size > 0 ? size : fallback) / (1024 * 1024)));
        };
        const ratio = Number(limits.cacheCleanTargetRatio || 0.8);
        const schedule = this.parseDailyCacheSchedule(limits.cacheCleanSchedule || '0 0 * * *');

        this.adminCacheSettings = {
            bookCacheSizeMb: toMb(limits.bookCacheSize, 2048 * 1024 * 1024),
            coverCacheSizeMb: toMb(limits.coverCacheSize, 512 * 1024 * 1024),
            cacheCleanEnabled: schedule.enabled,
            cacheCleanFrequency: schedule.frequency,
            cacheCleanTime: schedule.time,
            cacheCleanWeekDay: schedule.weekDay,
            cacheCleanMonthDay: schedule.monthDay,
            cacheCleanAdvancedSchedule: schedule.advancedSchedule,
            cacheCleanTargetPercent: Math.max(10, Math.min(100, Math.round(ratio * 100))),
        };
    }

    parseAdminCacheSchedule(schedule = '') {
        const text = String(schedule || '').trim();
        if (!text)
            return this.makeParsedAdminCacheSchedule({enabled: false});

        const fields = text.split(/\s+/);
        if (fields.length !== 5)
            return this.makeParsedAdminCacheSchedule({advancedSchedule: text});

        const [minuteText, hourText, dayOfMonth, month, dayOfWeek] = fields;
        const minute = this.clampAdminCacheNumber(minuteText, 0, 59, 0);
        const hour = this.clampAdminCacheNumber(hourText, 0, 23, 0);
        const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        if (month === '*' && dayOfMonth === '*' && dayOfWeek === '*')
            return this.makeParsedAdminCacheSchedule({frequency: 'daily', time});

        if (month === '*' && dayOfMonth === '*' && /^\d{1,2}$/.test(dayOfWeek)) {
            const weekDay = this.clampAdminCacheNumber(dayOfWeek, 0, 7, 1);
            return this.makeParsedAdminCacheSchedule({frequency: 'weekly', time, weekDay: weekDay === 7 ? 0 : weekDay});
        }

        if (month === '*' && dayOfWeek === '*' && /^\d{1,2}$/.test(dayOfMonth)) {
            const monthDay = this.clampAdminCacheNumber(dayOfMonth, 1, 31, 1);
            return this.makeParsedAdminCacheSchedule({frequency: 'monthly', time, monthDay});
        }

        return this.makeParsedAdminCacheSchedule({advancedSchedule: text});
    }

    makeParsedAdminCacheSchedule(values = {}) {
        return {
            enabled: values.enabled !== false,
            frequency: values.frequency || (values.advancedSchedule ? 'advanced' : 'daily'),
            time: values.time || '00:00',
            weekDay: values.weekDay === 0 ? 0 : (values.weekDay || 1),
            monthDay: values.monthDay || 1,
            advancedSchedule: values.advancedSchedule || '',
        };
    }

    clampAdminCacheNumber(value, min, max, fallback) {
        const parsed = parseInt(value, 10);
        if (!Number.isFinite(parsed))
            return fallback;

        return Math.max(min, Math.min(max, parsed));
    }

    parseDailyCacheSchedule(schedule = '') {
        return this.parseAdminCacheSchedule(schedule);
    }

    dailyCacheScheduleFromSettings(settings = this.adminCacheSettings) {
        if (!settings.cacheCleanEnabled)
            return '';
        if (settings.cacheCleanAdvancedSchedule && !['daily', 'weekly', 'monthly'].includes(settings.cacheCleanFrequency))
            return settings.cacheCleanAdvancedSchedule;

        const match = String(settings.cacheCleanTime || '00:00').trim().match(/^(\d{1,2}):(\d{2})$/);
        const hour = match ? this.clampAdminCacheNumber(match[1], 0, 23, 0) : 0;
        const minute = match ? this.clampAdminCacheNumber(match[2], 0, 59, 0) : 0;
        const frequency = String(settings.cacheCleanFrequency || 'daily');

        if (frequency === 'weekly') {
            const weekDay = this.clampAdminCacheNumber(settings.cacheCleanWeekDay, 0, 7, 1);
            return `${minute} ${hour} * * ${weekDay === 7 ? 0 : weekDay}`;
        }

        if (frequency === 'monthly') {
            const monthDay = this.clampAdminCacheNumber(settings.cacheCleanMonthDay, 1, 31, 1);
            return `${minute} ${hour} ${monthDay} * *`;
        }

        return `${minute} ${hour} * * *`;
    }

    adminCacheWeekDayLabel(value = 1) {
        const normalized = value === 7 ? 0 : value;
        const option = this.adminCacheWeekDayOptions.find(item => item.value === normalized);
        return option ? option.label.toLowerCase() : '';
    }

    formatBytes(value) {
        let size = Number(value || 0);
        if (!(size > 0))
            return '0 MB';

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) {
            size /= 1024;
            unit++;
        }

        return `${size.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
    }

    formatDateTime(value = '') {
        if (!value)
            return '';

        try {
            return new Date(value).toLocaleString();
        } catch (e) {
            return value;
        }
    }

    formatDuration(seconds = 0) {
        let total = Math.max(0, Math.round(Number(seconds || 0)));
        const days = Math.floor(total / 86400);
        total -= days * 86400;
        const hours = Math.floor(total / 3600);
        total -= hours * 3600;
        const minutes = Math.floor(total / 60);

        return [
            days ? `${days}д` : '',
            hours ? `${hours}ч` : '',
            `${minutes}м`,
        ].filter(Boolean).join(' ');
    }

    adminStat(name) {
        const stats = (this.adminDashboard && this.adminDashboard.stats) || {};
        const value = stats[name];
        return (value === undefined || value === null ? '0' : String(value));
    }

    adminCacheLimitText(kind = '') {
        const limits = (this.adminDashboard && this.adminDashboard.limits) || {};
        const limit = kind === 'book' ? limits.bookCacheSize : limits.coverCacheSize;
        const target = kind === 'book' ? limits.bookCacheTargetSize : limits.coverCacheTargetSize;
        const schedule = String(limits.cacheCleanSchedule || '').trim();
        const parts = [];

        if (limit !== null && limit !== undefined)
            parts.push(`Лимит: ${this.formatBytes(limit)}`);
        if (target !== null && target !== undefined)
            parts.push(this.adminCacheTargetText(target));
        parts.push(this.adminCacheScheduleText(schedule, limits.cacheCleanNextRunAt, limits.cacheCleanServerTimeZone));

        return parts.filter(Boolean).join(' · ');
    }

    adminCacheTargetText(value) {
        if (value === null || value === undefined)
            return '';

        return `Цель после чистки: ${this.formatBytes(value)}`;
    }

    adminCacheScheduleText(schedule = '', nextRunAt = '', timeZone = '') {
        if (!schedule)
            return 'Ротация: отключена';

        const parts = [`Ротация: ${this.adminCacheScheduleLabel(schedule)}`];
        const nextRun = this.formatServerDateTime(nextRunAt, timeZone);
        if (nextRun)
            parts.push(`след.: ${nextRun}`);
        if (timeZone)
            parts.push(timeZone);

        return parts.join(' · ');
    }

    adminCacheScheduleLabel(schedule = '') {
        const parsed = this.parseAdminCacheSchedule(schedule);
        if (!parsed.enabled)
            return 'отключена';
        if (parsed.advancedSchedule)
            return schedule;
        if (parsed.frequency === 'weekly')
            return `еженедельно, ${this.adminCacheWeekDayLabel(parsed.weekDay)} в ${parsed.time}`;
        if (parsed.frequency === 'monthly')
            return `ежемесячно, ${parsed.monthDay} числа в ${parsed.time}`;

        return `ежедневно в ${parsed.time}`;
    }

    formatServerDateTime(value = '', timeZone = '') {
        if (!value)
            return '';

        try {
            return new Date(value).toLocaleString('ru-RU', {
                timeZone: timeZone || undefined,
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch (e) {
            return this.formatDateTime(value);
        }
    }

    get adminUptime() {
        return this.formatDuration(this.adminDashboard && this.adminDashboard.uptime);
    }

    get adminIndex() {
        return (this.adminDashboard && this.adminDashboard.index) || {};
    }

    get adminIndexBusy() {
        const state = String(this.adminIndex.state || '');
        return state === 'db_creating' || state === 'db_loading' || (this.adminReindexInProgress && this.adminIndex.ready !== true);
    }

    get adminIndexStatusVisible() {
        return this.adminIndexBusy || this.adminSourcesReindexNeeded || this.adminIndex.ready === false;
    }

    get adminIndexStatusTitle() {
        if (this.adminIndexBusy)
            return this.adminUi.indexBusy;
        if (this.adminSourcesReindexNeeded)
            return this.adminUi.indexNeedsReindex;
        if (this.adminIndex.ready === false)
            return this.adminUi.indexNotReady;

        return this.adminUi.indexReady;
    }

    get adminIndexStatusText() {
        return this.adminIndex.jobMessage
            || this.adminIndex.serverMessage
            || (this.adminSourcesReindexNeeded ? this.adminUi.sourcesNeedReindex : this.adminUi.indexWaiting);
    }

    get adminIndexProgress() {
        const progress = parseFloat(this.adminIndex.progress);
        if (!Number.isFinite(progress) || progress <= 0)
            return 0;

        return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
    }

    get adminCoverStats() {
        return (this.adminDashboard && this.adminDashboard.covers) || {};
    }

    get adminCoverErrors() {
        return Array.isArray(this.adminCoverStats.latestErrors) ? this.adminCoverStats.latestErrors : [];
    }

    get adminTasks() {
        return Array.isArray(this.adminDashboard.tasks) ? this.adminDashboard.tasks : [];
    }

    taskProgress(task = {}) {
        const progress = parseFloat(task.progress);
        if (!Number.isFinite(progress) || progress <= 0)
            return 0;

        return Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
    }

    get adminSourcesChanged() {
        const original = ((this.adminDashboard && this.adminDashboard.sources) || [])
            .map(source => this.normalizeAdminSourceForCompare(source));
        const current = (this.adminSources || [])
            .map(source => this.normalizeAdminSourceForCompare(source));
        return JSON.stringify(original) !== JSON.stringify(current);
    }

    normalizeAdminSourceForCompare(source = {}) {
        return {
            id: String(source.id || '').trim(),
            name: String(source.name || '').trim(),
            inpx: String(source.inpx || '').trim(),
            libDir: String(source.libDir || '').trim(),
            enabled: source.enabled !== false,
        };
    }

    syncAdminSources() {
        const sources = (this.adminDashboard && this.adminDashboard.sources) || [];
        this.adminSources = sources.map(source => ({
            id: source.id || '',
            name: source.name || '',
            inpx: source.inpx || '',
            libDir: source.libDir || '',
            enabled: source.enabled !== false,
            inpxExists: source.inpxExists === true,
            libDirExists: source.libDirExists === true,
            foundInpx: source.foundInpx || [],
            archiveCount: source.archiveCount || 0,
            archiveCountTruncated: source.archiveCountTruncated === true,
            hasCovers: source.hasCovers === true,
            hasEtc: source.hasEtc === true,
            hasImages: source.hasImages === true,
            hasBin: source.hasBin === true,
            diagnosticsLoading: false,
        }));
    }

    async toggleAdminExpanded() {
        this.adminExpanded = !this.adminExpanded;
        if (this.adminExpanded && !this.adminDashboard.generatedAt)
            await this.loadAdminPanel();
    }

    async loadAdminPanel() {
        this.adminLoading = true;
        try {
            await this.refreshAdminDashboard(true);
            this.refreshAdminEvents();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminLoading = false;
        }
    }

    async refreshAdminDashboard(syncSources = false) {
        this.adminDashboard = await this.api.getAdminDashboard();
        this.syncAdminCacheSettings();
        if (syncSources)
            this.syncAdminSources();
    }

    scheduleAdminIndexPolling(delay = 2500) {
        this.stopAdminIndexPolling();
        this.adminIndexPollTimer = setTimeout(async() => {
            this.adminIndexPollTimer = null;
            if (!this.adminExpanded && !this.adminReindexInProgress)
                return;

            try {
                await this.refreshAdminDashboard(false);
                if (this.adminIndexBusy) {
                    this.scheduleAdminIndexPolling();
                } else {
                    this.adminReindexInProgress = false;
                    this.refreshAdminEvents();
                }
            } catch (e) {
                this.adminReindexInProgress = false;
                this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
            }
        }, delay);
    }

    stopAdminIndexPolling() {
        if (!this.adminIndexPollTimer)
            return;

        clearTimeout(this.adminIndexPollTimer);
        this.adminIndexPollTimer = null;
    }

    async refreshAdminEvents() {
        const requestId = ++this.adminEventsRequestId;
        this.adminEventsLoading = true;
        try {
            const result = await this.api.getAdminEvents({
                level: this.adminEventLevel,
                category: this.adminEventCategory,
                limit: 50,
            });
            if (requestId !== this.adminEventsRequestId)
                return;

            this.adminEventLogEnabled = result.enabled !== false;
            this.adminEventLogSize = parseInt(result.maxSize, 10) || 300;
            this.adminEvents = result.events || [];
        } catch (e) {
            if (requestId === this.adminEventsRequestId)
                this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            if (requestId === this.adminEventsRequestId)
                this.adminEventsLoading = false;
        }
    }

    async saveAdminEventLog() {
        try {
            const result = await this.api.updateAdminEventLog({
                enabled: this.adminEventLogEnabled,
                maxSize: this.adminEventLogSize,
            });
            this.adminEventLogEnabled = result.enabled !== false;
            this.adminEventLogSize = parseInt(result.maxSize, 10) || this.adminEventLogSize;
            await this.refreshAdminEvents();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        }
    }

    async addAdminTestEvent() {
        this.adminTestEventLoading = true;
        try {
            await this.api.addAdminTestEvent('warn');
            await this.refreshAdminEvents();
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminTestEventLoading = false;
        }
    }

    addAdminSource() {
        this.adminSources.push({
            id: '',
            name: '',
            inpx: '',
            libDir: '',
            enabled: true,
            inpxExists: false,
            libDirExists: false,
            foundInpx: [],
            archiveCount: 0,
            archiveCountTruncated: false,
            hasCovers: false,
            hasEtc: false,
            hasImages: false,
            hasBin: false,
            diagnosticsLoading: false,
        });
    }

    removeAdminSource(index) {
        this.adminSources.splice(index, 1);
    }

    setAdminSource(index, patch = {}) {
        const source = this.adminSources[index];
        if (!source)
            return;

        this.adminSources.splice(index, 1, Object.assign({}, source, patch));
    }

    async diagnoseAdminSource(index) {
        const source = this.adminSources[index];
        if (!source)
            return;

        this.setAdminSource(index, {diagnosticsLoading: true});
        try {
            const diagnostics = await this.api.adminDiagnoseLibrarySource(source);
            this.setAdminSource(index, Object.assign({}, diagnostics, {diagnosticsLoading: false}));
        } catch (e) {
            this.setAdminSource(index, {diagnosticsLoading: false});
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        }
    }

    async saveAdminSources() {
        this.adminSourcesLoading = true;
        try {
            const needsReindex = this.adminSourcesChanged;
            await this.api.updateAdminLibrarySources(this.adminSources);
            await this.api.updateConfig();
            await this.loadAdminPanel();
            this.adminSourcesReindexNeeded = this.adminSourcesReindexNeeded || needsReindex;
            this.$root.notify.success(this.adminUi.savedSources);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminSourcesLoading = false;
        }
    }

    cacheCleanSummary(result = {}) {
        const rows = Array.isArray(result.cleaned) ? result.cleaned : [];
        if (!rows.length)
            return 'Кэш уже чист';

        return rows.map(row => {
            const title = row.title || row.id || 'Кэш';
            const removed = Number(row.removed || 0);
            return `${title}: удалено ${removed}, сейчас ${this.formatBytes(row.after || row.size || 0)}`;
        }).join(' · ');
    }

    async saveAdminCacheSettings() {
        this.adminCacheSaveLoading = true;
        try {
            await this.api.updateAdminCache({
                bookCacheSizeMb: this.adminCacheSettings.bookCacheSizeMb,
                coverCacheSizeMb: this.adminCacheSettings.coverCacheSizeMb,
                cacheCleanSchedule: this.dailyCacheScheduleFromSettings(),
                cacheCleanTargetPercent: this.adminCacheSettings.cacheCleanTargetPercent,
            });
            await this.api.updateConfig();
            await this.refreshAdminDashboard(false);
            this.$root.notify.success('Настройки ротации кэша сохранены');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminCacheSaveLoading = false;
        }
    }

    async cleanAdminCache(kind = 'all') {
        const normalizedKind = String(kind || 'all');
        if (normalizedKind === 'book')
            this.adminCleanBookCacheLoading = true;
        else if (normalizedKind === 'cover')
            this.adminCleanCoverCacheLoading = true;
        else
            this.adminCleanLoading = true;

        try {
            const result = await this.api.adminCleanCache(normalizedKind);
            await this.loadAdminPanel();
            this.$root.notify.success(this.cacheCleanSummary(result));
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            if (normalizedKind === 'book')
                this.adminCleanBookCacheLoading = false;
            else if (normalizedKind === 'cover')
                this.adminCleanCoverCacheLoading = false;
            else
                this.adminCleanLoading = false;
        }
    }

    async cleanBrokenCovers() {
        this.adminBrokenCoversLoading = true;
        try {
            const result = await this.api.adminCleanBrokenCovers();
            await this.loadAdminPanel();
            this.$root.notify.success(`${this.adminUi.brokenCoversCleaned}: ${result.removed || 0}`);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminBrokenCoversLoading = false;
        }
    }

    async rebuildAdminCover() {
        const bookUid = String(this.adminCoverBookUid || '').trim();
        if (!bookUid) {
            this.$root.stdDialog.alert(this.adminUi.coverBookUid, this.mailUi.errorTitle);
            return;
        }

        this.adminCoverRebuildLoading = true;
        try {
            const result = await this.api.adminRebuildCover(bookUid);
            await this.refreshAdminDashboard(false);
            this.$root.notify.success(this.adminUi.coverRebuildStarted);
            if (result.coverUrl)
                window.setTimeout(() => { (new Image()).src = `${result.coverUrl}?t=${Date.now()}`; }, 50);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminCoverRebuildLoading = false;
        }
    }

    async reindexAdmin() {
        this.adminReindexLoading = true;
        try {
            await this.api.adminReindex();
            this.adminSourcesReindexNeeded = false;
            this.adminReindexInProgress = true;
            await this.refreshAdminDashboard(false);
            this.scheduleAdminIndexPolling(1500);
            this.$root.notify.success(this.adminUi.reindexStarted);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminReindexLoading = false;
        }
    }

    async saveIntegrations(options = {}) {
        if (!this.canEditExternalDiscovery)
            return false;

        this.integrationSaveLoading = true;
        try {
            const result = await this.api.updateAdminIntegrations(this.integrations);
            if (result && result.integrations)
                this.integrations = Object.assign(this.makeDefaultIntegrations(), result.integrations);
            await this.api.updateConfig();
            if (!options.quiet)
                this.$root.notify.success(this.mailUi.saved);
            return true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
            return false;
        } finally {
            this.integrationSaveLoading = false;
        }
    }

    async testSmtp() {
        const saved = await this.saveIntegrations({quiet: true});
        if (!saved)
            return;

        this.smtpTestLoading = true;
        try {
            const result = await this.api.testAdminIntegration('smtp');
            this.$root.notify.success((result && result.message) || 'SMTP ok');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.smtpTestLoading = false;
        }
    }

    async testTelegram() {
        const saved = await this.saveIntegrations({quiet: true});
        if (!saved)
            return;

        this.telegramTestLoading = true;
        try {
            const result = await this.api.testAdminIntegration('telegram');
            this.$root.notify.success((result && result.message) || 'Telegram ok');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.telegramTestLoading = false;
        }
    }

    async saveOpdsSettings() {
        if (!this.canEditExternalDiscovery)
            return false;

        this.opdsSaveLoading = true;
        try {
            const result = await this.api.updateAdminOpds(this.opdsSettings);
            if (result && result.opds)
                this.opdsSettings = Object.assign(this.makeDefaultOpdsSettings(), result.opds);
            await this.api.updateConfig();
            this.$root.notify.success(this.opdsUi.saved);
            return true;
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
            return false;
        } finally {
            this.opdsSaveLoading = false;
        }
    }

    downloadJsonFile(fileName, data) {
        const blob = new Blob([JSON.stringify(data, null, 4)], {type: 'application/json;charset=utf-8'});
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    async exportSettings() {
        this.settingsExportLoading = true;
        try {
            const result = await this.api.exportAdminSettings();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.downloadJsonFile(`inpx-web-settings-${stamp}.json`, result);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.settingsExportLoading = false;
        }
    }

    openSettingsImport() {
        const input = this.$refs.settingsImportInput;
        if (!input)
            return;

        input.value = '';
        input.click();
    }

    openBackupImport() {
        const input = this.$refs.backupImportInput;
        if (!input)
            return;

        input.value = '';
        input.click();
    }

    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize)
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        return btoa(binary);
    }

    async onSettingsImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;

        this.settingsImportLoading = true;
        try {
            const data = JSON.parse(await file.text());
            await this.api.importAdminSettings(data);
            await this.api.updateConfig();
            this.loadSettings();
            this.$root.notify.success('Настройки восстановлены');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.settingsImportLoading = false;
            if (input)
                input.value = '';
        }
    }

    async onBackupImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;

        const confirmed = await this.$root.stdDialog.confirm(
            this.backupUi.restoreConfirm,
            this.backupUi.backupImport,
        );
        if (!confirmed) {
            input.value = '';
            return;
        }

        this.backupImportLoading = true;
        try {
            const contentBase64 = this.arrayBufferToBase64(await file.arrayBuffer());
            await this.api.importAdminBackup({fileName: file.name, contentBase64});
            await this.api.updateConfig();
            this.loadSettings();
            this.$root.notify.success(this.backupUi.restored);
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.backupImportLoading = false;
            if (input)
                input.value = '';
        }
    }

    async createBackup() {
        this.backupLoading = true;
        try {
            const result = await this.api.createAdminBackup();
            if (result && result.link) {
                window.location.href = result.link;
                this.$root.notify.success(this.backupUi.ready);
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.backupLoading = false;
        }
    }

    okClick() {
        this.dialogVisible = false;
    }
}

export default vueComponent(SettingsDialog);
//-----------------------------------------------------------------------------
</script>

<style scoped>
.settings-dialog-body {
    padding-bottom: 16px;
}

.settings-inline-row {
    flex-wrap: wrap;
    gap: 6px 8px;
}

.settings-inline-label {
    min-width: 132px;
}

.settings-inline-summary {
    flex: 1 1 220px;
    min-width: 180px;
}

.settings-card-view {
    flex-wrap: wrap;
    gap: 8px;
}

.settings-card-view-label {
    min-width: 110px;
}

.settings-card-view-toggle {
    background: var(--app-surface);
}

.admin-mail-box {
    margin: 18px 0 4px;
    padding: 14px;
    border: 1px solid var(--app-border);
    border-radius: 14px;
    background: var(--app-surface);
}

.admin-collapse-box {
    padding: 0;
    overflow: hidden;
}

.admin-collapse-head {
    display: flex;
    align-items: center;
    width: 100%;
    gap: 12px;
    padding: 14px;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}

.admin-collapse-copy {
    min-width: 0;
    flex: 1;
}

.admin-collapse-icon {
    flex: 0 0 auto;
    color: var(--app-muted);
}

.admin-collapse-body {
    padding: 0 14px 14px;
}

.admin-mail-title {
    font-size: 15px;
    font-weight: 800;
}

.admin-mail-subtitle {
    margin-top: 3px;
    font-size: 12px;
    color: var(--app-muted);
}

.admin-backup-note {
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    color: var(--app-muted);
    font-size: 12px;
    line-height: 1.4;
}

.admin-backup-note > div + div {
    margin-top: 6px;
}

.admin-mail-section {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--app-border);
}

.admin-mail-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}

.admin-mail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 8px;
}

.admin-mail-wide,
.admin-mail-actions {
    grid-column: span 2;
}

.admin-mail-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
}

.admin-backup-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
}

.admin-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
}

.admin-cache-settings-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    column-gap: 10px;
    row-gap: 18px;
    margin-top: 14px;
}

.admin-cache-enabled-toggle {
    grid-column: 1 / -1;
    align-self: center;
    min-height: 40px;
    margin-top: 2px;
    padding-top: 14px;
    border-top: 1px solid var(--app-border);
}

.admin-cache-time-input {
    min-width: 150px;
}

.admin-cache-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 14px;
}

.admin-index-status {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-top: 12px;
    padding: 10px 12px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    color: var(--app-text);
    background: color-mix(in srgb, var(--app-primary) 5%, var(--app-surface));
}

.admin-index-status--busy {
    border-color: color-mix(in srgb, var(--app-primary) 45%, var(--app-border));
}

.admin-index-status-copy {
    min-width: 0;
    flex: 1;
}

.admin-index-status-title {
    font-weight: 800;
}

.admin-index-status-text {
    margin-top: 2px;
    color: var(--app-muted);
    font-size: 13px;
}

.admin-index-status :deep(.q-linear-progress) {
    margin-top: 8px;
}

.admin-dashboard-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-top: 12px;
}

.admin-dashboard-grid--compact {
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

.admin-stat {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--app-primary) 4%, var(--app-surface));
}

.admin-stat-label {
    font-size: 11px;
    color: var(--app-muted);
}

.admin-stat-value {
    margin-top: 4px;
    font-size: 16px;
    font-weight: 800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.admin-stat-hint {
    margin-top: 4px;
    color: var(--app-muted);
    font-size: 11px;
    line-height: 1.25;
}

.admin-subsection {
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--app-border);
}

.admin-subsection-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
}

.admin-source-list {
    display: grid;
    gap: 10px;
    margin-top: 10px;
}

.admin-source-row {
    display: grid;
    grid-template-columns: auto minmax(120px, 0.8fr) minmax(180px, 1.2fr) minmax(180px, 1.2fr) auto auto;
    gap: 8px;
    align-items: center;
}

.admin-source-diagnostics {
    grid-column: 2 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-source-diagnostics span {
    padding: 2px 6px;
    border-radius: 999px;
    background: rgba(23, 32, 38, 0.05);
}

.admin-cover-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    margin-top: 12px;
}

.admin-task-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
}

.admin-task-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    padding: 10px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    background: rgba(23, 32, 38, 0.04);
}

.admin-task-row--active {
    border-color: color-mix(in srgb, var(--app-primary) 45%, var(--app-border));
}

.admin-task-title {
    font-size: 13px;
    font-weight: 800;
}

.admin-task-message,
.admin-task-error {
    margin-top: 3px;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-task-error {
    color: #dc2626;
    font-weight: 700;
}

.admin-task-main :deep(.q-linear-progress) {
    margin-top: 8px;
}

.admin-source-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    color: var(--app-accent);
    font-size: 13px;
    font-weight: 700;
}

.admin-event-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

.admin-event-filters :deep(.q-field) {
    min-width: 132px;
}

.admin-empty {
    margin-top: 10px;
    color: var(--app-muted);
    font-size: 13px;
}

.admin-event-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
    max-height: 260px;
    overflow: auto;
}

.admin-event-list--compact {
    max-height: 180px;
}

.admin-event-row {
    padding: 8px 10px;
    border-left: 3px solid var(--app-border);
    border-radius: 8px;
    background: rgba(23, 32, 38, 0.04);
}

.admin-event-row--warn {
    border-left-color: #d97706;
}

.admin-event-row--error {
    border-left-color: #dc2626;
}

.admin-event-meta {
    font-size: 11px;
    color: var(--app-muted);
}

.admin-event-message {
    margin-top: 3px;
    font-size: 13px;
    font-weight: 700;
}

.password-visibility-toggle {
    cursor: pointer;
}

.settings-dialog-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 18px;
    padding-top: 14px;
    border-top: 1px solid var(--app-border);
}

.settings-ok-btn {
    min-width: 78px;
}

@media (max-width: 720px) {
    .admin-dashboard-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .admin-cache-settings-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .admin-source-row {
        grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .admin-source-row :deep(.q-field) {
        grid-column: 2 / 3;
    }

    .admin-source-diagnostics {
        grid-column: 1 / 4;
    }

    .admin-cover-actions,
    .admin-task-row {
        grid-template-columns: 1fr;
    }

    .admin-mail-grid {
        grid-template-columns: 1fr;
    }

    .admin-mail-wide,
    .admin-mail-actions {
        grid-column: span 1;
    }

    .admin-mail-actions {
        justify-content: flex-start;
    }
}
</style>
