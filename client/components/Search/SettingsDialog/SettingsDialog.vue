<template>
    <Dialog ref="dialog" v-model="dialogVisible" variant="settings">
        <template #header>
            <span>Настройки</span>
        </template>

        <div class="settings-dialog-body">
            <h2 class="settings-heading">Личные настройки</h2>
            <details class="settings-group">
                <summary><q-icon name="la la-book-open" />Каталог и карточки</summary>
                <div class="settings-group-body">
                    <div class="settings-fields">
                        <q-select v-model="limit" :options="limitOptions" label="Книг на странице" outlined dense emit-value map-options />
                        <div class="settings-card-view">
                            <span>Вид каталога</span>
                            <q-btn-toggle v-model="bookCardView" class="settings-card-view-toggle" toggle-color="primary"
                                :options="bookCardViewOptions" no-caps unelevated />
                        </div>
                    </div>
                    <div class="settings-checks">
                        <q-checkbox v-model="darkTheme" size="36px" label="Ночная тема" />
                        <q-checkbox v-model="showDeleted" size="36px" label="Показывать удалённые книги" />
                        <q-checkbox v-model="showCounts" size="36px" label="Показывать количество книг" />
                        <q-checkbox v-model="showRates" size="36px" label="Показывать оценки" />
                        <q-checkbox v-model="showGenres" size="36px" label="Показывать жанры" />
                        <q-checkbox v-model="showDates" size="36px" label="Показывать даты поступления" />
                        <q-checkbox v-model="showInfo" size="36px" label="Показывать кнопку «Инфо»" />
                        <q-checkbox v-model="abCacheEnabled" size="36px" label="Кэшировать запросы" />
                    </div>
                    <div class="settings-checks settings-divider">
                        <q-checkbox v-model="autoLoadBookReviews" size="36px" label="Автоматически загружать отзывы и оценки" />
                        <q-checkbox v-model="autoLoadAuthorInfo" size="36px" label="Автоматически загружать сведения об авторе" />
                    </div>
                </div>
            </details>

            <details v-if="discoveryEnabled" class="settings-group">
                <summary><q-icon name="la la-bookmark" />Полки и витрины</summary>
                <div class="settings-group-body">
                    <div class="settings-checks">
                        <q-checkbox v-model="showDiscoveryNewest" size="36px" label="Новинки" />
                        <q-checkbox v-model="showDiscoveryPopular" size="36px" label="Популярное" />
                        <q-checkbox v-model="showDiscoveryContinueReading" size="36px" label="Продолжить чтение" />
                        <q-checkbox v-model="showDiscoveryFromLists" size="36px" label="Из ваших списков" />
                        <q-checkbox v-model="showDiscoveryUnfinishedSeries" size="36px" label="Незаконченные серии" />
                        <q-checkbox v-model="showDiscoverySimilar" size="36px" label="Похоже на то, что вы читали" />
                        <q-checkbox v-if="effectiveExternalDiscoveryAvailable" v-model="showDiscoveryExternal" size="36px" label="Внешняя подборка" />
                    </div>
                    <div class="settings-checks settings-divider">
                        <q-checkbox v-model="showDiscoveryUnreadOnly" size="36px" label="Только непрочитанное в «Для вас»" />
                        <q-checkbox v-model="compactDiscoveryCards" size="36px" label="Компактные карточки" />
                    </div>
                    <div class="settings-fields">
                        <q-select v-model="discoveryNewestLimit" :options="discoveryLimitOptions" label="Книг в «Новинках»" outlined dense emit-value map-options />
                        <q-select v-model="discoveryPopularLimit" :options="discoveryLimitOptions" label="Книг в «Популярном»" outlined dense emit-value map-options />
                    </div>
                </div>
            </details>

            <details class="settings-group">
                <summary><q-icon name="la la-mobile" />Приложение и загрузки</summary>
                <div class="settings-group-body">
                    <AppConnectionSettings />
                    <q-checkbox v-model="downloadAsZip" size="36px" label="Скачивать книги в ZIP" />
                    <q-checkbox v-if="config.latestVersion" v-model="showNewReleaseAvailable" size="36px" label="Уведомлять о новой версии" />
                </div>
            </details>

            <h2 v-if="canEditExternalDiscovery" class="settings-heading">Управление библиотекой</h2>
            <button v-if="canEditExternalDiscovery" type="button" class="settings-task-link" @click="$emit('open-library-tasks')">
                <q-icon name="la la-tasks" />Задачи и состояние библиотеки<q-icon name="la la-angle-right" />
            </button>
            <div v-if="canEditExternalDiscovery && adminDashboardAvailable" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" :aria-expanded="performanceExpanded" @click="performanceExpanded = !performanceExpanded">
                    <q-icon class="settings-icon" name="la la-tachometer-alt" />
                    <span class="admin-collapse-copy">Производительность</span>
                    <q-icon class="admin-collapse-icon" :name="performanceExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>
                <PerformancePanel v-if="dialogVisible && performanceExpanded" />
            </div>
            <button v-if="canEditExternalDiscovery && discoveryEnabled" type="button" class="settings-task-link" @click="discoverySourceDialogVisible = true">
                <q-icon name="la la-globe" />
                <span>Внешний источник витрины<small class="settings-source-name">{{ externalDiscoverySummary }}</small></span>
                <q-icon name="la la-angle-right" />
            </button>
            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" :aria-expanded="adminExpanded" @click="toggleAdminExpanded">
                    <q-icon class="settings-icon" name="la la-server" />
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ adminUi.title }}</div>
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

                    <div class="admin-dashboard-sections">
                        <section class="admin-dashboard-section">
                            <div class="admin-dashboard-section-title">Библиотека</div>
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
                            </div>
                        </section>

                        <section class="admin-dashboard-section">
                            <div class="admin-dashboard-section-title">Процесс</div>
                            <div class="admin-dashboard-grid">
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.uptime }}</div>
                                    <div class="admin-stat-value">{{ adminUptime }}</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.memory }}</div>
                                    <div class="admin-stat-value">{{ formatBytes(adminDashboard.memory && adminDashboard.memory.rss) }}</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.cpu }}</div>
                                    <div class="admin-stat-value">{{ adminCpuText }}</div>
                                    <div class="admin-stat-hint">{{ adminCpuHint }}</div>
                                </div>
                            </div>
                        </section>

                        <section v-if="adminActivity" class="admin-dashboard-section" aria-labelledby="admin-activity-title">
                            <h3 id="admin-activity-title" class="admin-dashboard-section-title admin-activity-title">Активность пользователей</h3>
                            <div class="admin-mail-subtitle">С последнего запуска сервера</div>
                            <div class="admin-dashboard-grid admin-dashboard-grid--activity">
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Входы в профиль</div>
                                    <div class="admin-stat-value">{{ adminActivity.totals.logins.toLocaleString('ru-RU') }}</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Скачано книг</div>
                                    <div class="admin-stat-value">{{ adminActivity.totals.downloads.toLocaleString('ru-RU') }}</div>
                                </div>
                            </div>
                            <details v-if="adminActivity.profiles.length" class="admin-activity-details">
                                <summary><span>По профилям</span></summary>
                                <div class="admin-activity-scroll" role="region" aria-label="Активность по профилям" tabindex="0">
                                    <table class="admin-activity-table">
                                        <thead>
                                            <tr><th scope="col">Учётная запись</th><th scope="col">Входы</th><th scope="col">Скачано книг</th></tr>
                                        </thead>
                                        <tbody>
                                            <tr v-for="row in adminActivity.profiles" :key="row.profile">
                                                <th scope="row">
                                                    <span v-if="row.profile === 'guest'">Гости</span>
                                                    <span v-else-if="row.profile === 'other'">Остальные профили</span>
                                                    <template v-else>
                                                        <span>{{ row.login || row.name || row.profile }}</span>
                                                        <small v-if="row.login && row.name && row.name !== row.login" class="admin-activity-name">{{ row.name }}</small>
                                                    </template>
                                                </th>
                                                <td>{{ row.logins.toLocaleString('ru-RU') }}</td>
                                                <td>{{ row.downloads.toLocaleString('ru-RU') }}</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </details>
                        </section>

                        <section class="admin-dashboard-section admin-dashboard-section--wide">
                            <div class="admin-dashboard-section-title">{{ adminUi.requests }}</div>
                            <div class="admin-dashboard-grid admin-dashboard-grid--runtime">
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.actionsTotal }}</div>
                                    <div class="admin-stat-value">{{ adminRuntime.totalActions || 0 }}</div>
                                    <div class="admin-stat-hint">{{ adminRuntimeHint }}</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.eventLoopLag }}</div>
                                    <div class="admin-stat-value">{{ runtimeLagText }}</div>
                                    <div class="admin-stat-hint">{{ runtimeLagHint }}</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">{{ adminUi.lastSlowAction }}</div>
                                    <div class="admin-stat-value admin-stat-value--small">{{ runtimeLastSlowActionText }}</div>
                                    <div class="admin-stat-hint">{{ runtimeLastSlowActionHint }}</div>
                                </div>
                            </div>
                            <div v-if="runtimeSlowestActions.length" class="admin-runtime-list">
                                <div v-for="item in runtimeSlowestActions" :key="item.action" class="admin-runtime-row">
                                    <span class="admin-runtime-action">{{ item.action }}</span>
                                    <span class="admin-runtime-value">{{ actionDurationText(item) }}</span>
                                </div>
                            </div>
                        </section>

                        <section class="admin-dashboard-section admin-dashboard-section--wide">
                            <div class="admin-dashboard-section-title">Качество рекомендаций</div>
                            <div class="admin-dashboard-grid admin-dashboard-grid--runtime">
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Показы</div>
                                    <div class="admin-stat-value">{{ discoveryMetric('impression') }}</div>
                                    <div class="admin-stat-hint">{{ adminDiscovery.profiles || 0 }} профилей с событиями</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">CTR открытий</div>
                                    <div class="admin-stat-value">{{ discoveryRateText('ctr') }}</div>
                                    <div class="admin-stat-hint">{{ discoveryMetric('open') }} открытий</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Начали читать</div>
                                    <div class="admin-stat-value">{{ discoveryRateText('start') }}</div>
                                    <div class="admin-stat-hint">{{ discoveryMetric('start') }} стартов</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Сохранили</div>
                                    <div class="admin-stat-value">{{ discoveryRateText('save') }}</div>
                                    <div class="admin-stat-hint">{{ discoveryMetric('save') }} сохранений</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Негативные реакции</div>
                                    <div class="admin-stat-value">{{ discoveryRateText('negativeFeedback') }}</div>
                                    <div class="admin-stat-hint">{{ discoveryMetric('feedback') }} реакций всего</div>
                                </div>
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Настроили вкусы</div>
                                    <div class="admin-stat-value">{{ adminDiscovery.configuredProfiles || 0 }}</div>
                                    <div class="admin-stat-hint">Жанры, авторы или языки</div>
                                </div>
                            </div>
                        </section>

                        <section class="admin-dashboard-section">
                            <div class="admin-dashboard-section-title">Хранилище</div>
                            <div class="admin-dashboard-grid admin-dashboard-grid--storage">
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
                                <div class="admin-stat">
                                    <div class="admin-stat-label">Ротация кэша</div>
                                    <div class="admin-stat-value">{{ adminCacheRotationValue() }}</div>
                                    <div class="admin-stat-hint">{{ adminCacheRotationHint() }}</div>
                                </div>
                            </div>
                        </section>
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
                            <q-input v-if="adminCacheSettings.cacheCleanFrequency !== 'interval'" class="admin-cache-time-input" v-model="adminCacheSettings.cacheCleanTime" outlined dense type="time" label="Время запуска" hint="По времени сервера" persistent-hint :disable="!adminCacheSettings.cacheCleanEnabled || adminCacheSettings.cacheCleanFrequency === 'advanced'" />
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
                                <q-select v-model="source.type" outlined dense emit-value map-options label="Тип" :options="[{label: 'INPX', value: 'inpx'}, {label: 'Папка FB2/EPUB', value: 'folder'}]" />
                                <q-input v-if="source.type !== 'folder'" v-model="source.inpx" outlined dense :label="adminUi.sourceInpx" />
                                <q-input v-model="source.libDir" outlined dense :label="adminUi.sourceLibDir" />
                                <q-btn flat dense round color="primary" icon="la la-search" :loading="source.diagnosticsLoading" @click="diagnoseAdminSource(index)">
                                    <q-tooltip>{{ adminUi.checkSource }}</q-tooltip>
                                </q-btn>
                                <q-btn flat dense round color="negative" icon="la la-trash" @click="removeAdminSource(index)" />
                                <div class="admin-source-diagnostics">
                                    <span v-if="source.type !== 'folder'" :class="source.inpxExists ? 'text-positive' : 'text-negative'">INPX</span>
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
                <button class="admin-collapse-head" type="button" :aria-expanded="backupExpanded" @click="backupExpanded = !backupExpanded">
                    <q-icon class="settings-icon" name="la la-archive" />
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ backupUi.title }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="backupExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>

                <div v-show="backupExpanded" class="admin-collapse-body">
                    <BackupPanel v-if="backupExpanded" />
                    <div class="admin-backup-note">
                        <strong>Перенос только настроек</strong>
                        <div>{{ backupUi.settingsBackupInfo }}</div>
                    </div>
                    <div class="admin-backup-actions">
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
                    </div>
                </div>
            </div>

            <div v-if="canEditExternalDiscovery" class="admin-mail-box admin-collapse-box">
                <button class="admin-collapse-head" type="button" :aria-expanded="opdsExpanded" @click="opdsExpanded = !opdsExpanded">
                    <q-icon class="settings-icon" name="la la-rss" />
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ opdsUi.title }}</div>
                    </div>
                    <q-icon class="admin-collapse-icon" :name="opdsExpanded ? 'la la-angle-up' : 'la la-angle-down'" size="20px" />
                </button>
                <div v-show="opdsExpanded" class="admin-collapse-body">
                    <p v-if="!config.adminCache" class="admin-mail-subtitle">{{ opdsUi.subtitle }}</p>
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
                <button class="admin-collapse-head" type="button" :aria-expanded="mailExpanded" @click="mailExpanded = !mailExpanded">
                    <q-icon class="settings-icon" name="la la-paper-plane" />
                    <div class="admin-collapse-copy">
                        <div class="admin-mail-title">{{ mailUi.title }}</div>
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
                            <q-select v-model="integrations.telegramProxyMode" outlined dense emit-value map-options behavior="dialog" label="Маршрут Telegram" :options="telegramProxyModes" />
                            <q-select v-model="integrations.telegramIpFamily" outlined dense emit-value map-options behavior="dialog"
                                label="IP-семейство Telegram" :options="[{label:'Авто (IPv4 / IPv6)',value:'auto'},{label:'Только IPv4',value:'4'},{label:'Только IPv6',value:'6'}]" />
                            <p class="admin-mail-wide admin-mail-subtitle telegram-connection-hint">{{ telegramConnectionHint }}</p>
                            <template v-if="integrations.telegramProxyMode === 'custom'">
                                <q-select v-model="integrations.telegramProxyProtocol" outlined dense emit-value map-options behavior="dialog" label="Протокол прокси" :options="telegramProxyProtocols" />
                                <q-input v-model="integrations.telegramProxyHost" outlined dense clearable label="Адрес прокси" placeholder="Имя сервера или IP" maxlength="253" autocomplete="off" spellcheck="false" />
                                <q-input v-model.number="integrations.telegramProxyPort" outlined dense type="number" min="1" max="65535" label="Порт прокси" />
                                <q-input v-model="integrations.telegramProxyUsername" outlined dense clearable label="Пользователь прокси" autocomplete="off" maxlength="1024" />
                                <q-input v-model="integrations.telegramProxyPassword" outlined dense clearable :type="telegramProxyPasswordVisible ? 'text' : 'password'" label="Пароль прокси" autocomplete="new-password" maxlength="1024" :hint="integrations.telegramProxyPassword === '__KEEP__' ? 'Пароль сохранён. Введите новый или очистите поле.' : undefined">
                                    <template #append>
                                        <q-icon :name="telegramProxyPasswordVisible ? 'la la-eye-slash' : 'la la-eye'" class="password-visibility-toggle" @click="telegramProxyPasswordVisible = !telegramProxyPasswordVisible" />
                                    </template>
                                </q-input>
                            </template>
                            <q-input class="admin-mail-wide" v-model="integrations.telegramCaptionTemplate" outlined dense clearable :label="mailUi.telegramCaption" />
                        </div>
                        <q-toggle v-model="integrations.telegramBotEnabled" :disable="!integrations.telegramShareEnabled" label="Интерактивный бот: поиск, списки и получение книг" />
                        <p class="admin-mail-subtitle">Используйте отдельного бота без webhook. Если в профиле указан личный Chat ID, дополнительная привязка не нужна. Если Chat ID не заполнен, подключите чат одноразовой ссылкой из профиля.</p>
                        <TelegramBotStatus v-if="mailExpanded && dialogVisible" ref="telegramBotStatus" />
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

        </div>
        <template #footer>
            <q-btn class="settings-ok-btn" color="primary" unelevated no-caps label="OK" @click="okClick" />
        </template>

        <DiscoverySourceDialog v-if="canEditExternalDiscovery" v-model="discoverySourceDialogVisible" />
    </Dialog>
</template>

<script>
//-----------------------------------------------------------------------------
import vueComponent from '../../vueComponent.js';

import Dialog from '../../share/Dialog.vue';
import AppConnectionSettings from '../../Library/AppConnectionSettings.vue';
import DiscoverySourceDialog from '../DiscoverySourceDialog/DiscoverySourceDialog.vue';
import PerformancePanel from './PerformancePanel.vue';
import BackupPanel from './BackupPanel.vue';
import TelegramBotStatus from './TelegramBotStatus.vue';
import {telegramProbeNotice} from './telegramStatusModel';

const componentOptions = {
    emits: ['update:modelValue', 'open-library-tasks'],
    components: {
        Dialog,
        AppConnectionSettings,
        DiscoverySourceDialog,
        PerformancePanel,
        BackupPanel,
        TelegramBotStatus,
    },
    watch: {
        modelValue(newValue) {
            this.dialogVisible = newValue;
        },
        dialogVisible(newValue) {
            this.$emit('update:modelValue', newValue);
            if (!newValue) {
                this.stopAdminMetricsPolling();
                this.stopAdminIndexPolling();
                return;
            }

            if (this.adminExpanded && this.adminDashboard.generatedAt)
                this.startAdminMetricsPolling();
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
        autoLoadBookReviews(value) {this.commit('setSettings', {autoLoadBookReviews:value});},
        autoLoadAuthorInfo(value) {this.commit('setSettings', {autoLoadAuthorInfo:value});},
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
    autoLoadBookReviews = false;
    autoLoadAuthorInfo = false;
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
    telegramNotice = null;
    settingsExportLoading = false;
    settingsImportLoading = false;
    backupExpanded = false;
    opdsSaveLoading = false;
    smtpPassVisible = false;
    telegramTokenVisible = false;
    telegramProxyPasswordVisible = false;
    opdsPasswordVisible = false;
    opdsExpanded = false;
    mailExpanded = false;
    adminExpanded = false;
    performanceExpanded = false;
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
    adminMetricsPollTimer = null;
    adminMetricsPollInFlight = false;
    adminDashboard = {};
    adminCacheSettings = this.makeDefaultAdminCacheSettings();
    adminSources = [];
    adminEvents = [];
    adminEventLevel = 'all';
    adminEventCategory = 'all';
    adminEventLogEnabled = true;
    adminEventLogSize = 300;
    integrations = this.makeDefaultIntegrations();
    telegramProxyModes = [{label:'Прямое соединение',value:'direct'}, {label:'Прокси окружения сервера',value:'system'}, {label:'Свой прокси',value:'custom'}];
    telegramProxyProtocols = [{label:'HTTP',value:'http'}, {label:'HTTPS',value:'https'}, {label:'SOCKS5',value:'socks5'}, {label:'SOCKS5 (DNS через прокси)',value:'socks5h'}];
    opdsSettings = this.makeDefaultOpdsSettings();
    adminUi = {
        title: 'Администрирование',
        refresh: 'Обновить',
        cleanCache: 'Очистить кэш',
        reindex: 'Переиндексировать',
        books: 'Книги',
        authors: 'Авторы',
        series: 'Серии',
        uptime: 'Uptime',
        memory: 'Память',
        cpu: 'CPU процесса',
        requests: 'Запросы',
        actionsTotal: 'WebSocket action',
        eventLoopLag: 'Event loop',
        lastSlowAction: 'Медленный action',
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
        {label: 'Аудит', value: 'audit'},
        {label: 'Замеры', value: 'benchmark'},
        {label: 'Резервные копии', value: 'backup'},
        {label: 'Доступ', value: 'security'},
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
        settingsBackupInfo: 'JSON настроек нужен только для переноса конфигурации. Пользователи, списки, прогресс и закладки в него не входят.',
        settings: 'Экспорт настроек JSON',
        settingsImport: 'Восстановить настройки JSON',
    };
    mailUi = {
        title: 'Отправка книг',
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

    get adminCacheFrequencyOptions() {
        const options = [
            {label: 'Каждый день', value: 'daily'},
            {label: 'Раз в неделю', value: 'weekly'},
            {label: 'Раз в месяц', value: 'monthly'},
        ];
        const limits = this.adminDashboard?.limits || this.config.adminCache || {};
        if (this.hasCacheInterval(limits))
            options.push({label: this.cacheIntervalLabel(limits), value: 'interval'});
        return options;
    }

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

    mounted() {
        this.dialogVisible = this.modelValue;
    }

    unmounted() {
        this.stopAdminMetricsPolling();
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
            telegramBotEnabled: false,
            telegramBotToken: '',
            telegramIpFamily: 'auto',
            telegramProxyMode: 'system',
            telegramProxyProtocol: 'http',
            telegramProxyHost: '',
            telegramProxyPort: '',
            telegramProxyUsername: '',
            telegramProxyPassword: '',
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

    integrationValues(source = {}) {
        return Object.assign(this.makeDefaultIntegrations(), source, {
            smtpPort: parseInt(source.smtpPort, 10) || 587,
            telegramBotToken: source.telegramBotToken || (source.telegramBotTokenSet ? '__KEEP__' : ''),
            telegramProxyPassword: source.telegramProxyPasswordSet || source.telegramProxyPassword === '__KEEP__' ? '__KEEP__' : '',
            smtpPass: source.smtpPass || (source.smtpPassSet ? '__KEEP__' : ''),
        });
    }

    loadIntegrations() {
        this.integrations = this.integrationValues(this.config.adminIntegrations || {});
        this.telegramProxyPasswordVisible = false;
    }

    get telegramConnectionHint() {
        if (this.integrations.telegramProxyMode === 'custom')
            return 'IPv4/IPv6 применяется к соединению сервера с прокси. ' + (this.integrations.telegramProxyProtocol === 'socks5'
                ? 'SOCKS5 также использует это IP-семейство при локальном разрешении адреса Telegram.'
                : 'Адрес Telegram разрешает прокси-сервер.');
        if (this.integrations.telegramProxyMode === 'direct')
            return 'Сервер подключается к Telegram напрямую. IP-семейство применяется к соединению с Telegram.';
        return 'Используются HTTPS_PROXY, ALL_PROXY и NO_PROXY в окружении процесса сервера. Настройки браузера, ОС и PAC не читаются.';
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
        this.autoLoadBookReviews = settings.autoLoadBookReviews === true;
        this.autoLoadAuthorInfo = settings.autoLoadAuthorInfo === true;
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
        const limits = (this.adminDashboard && this.adminDashboard.limits) || this.config.adminCache || {};
        const toMb = (value, fallback) => {
            const size = Number(value || 0);
            return Math.max(1, Math.round((size > 0 ? size : fallback) / (1024 * 1024)));
        };
        const ratio = Number(limits.cacheCleanTargetRatio || 0.8);
        const schedule = this.hasCacheInterval(limits) ? this.makeParsedAdminCacheSchedule({frequency: 'interval'})
            : this.parseAdminCacheSchedule(limits.cacheCleanSchedule ?? '0 0 * * *');

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
        if (!/^\d+$/.test(minuteText) || !/^\d+$/.test(hourText))
            return this.makeParsedAdminCacheSchedule({advancedSchedule: text});
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

    hasCacheInterval(limits) {
        return !limits.cacheCleanSchedule && limits.cacheCleanInterval > 0 && Boolean(limits.cacheCleanNextRunAt);
    }

    cacheIntervalLabel(limits) {
        return `Каждые ${Number(limits.cacheCleanInterval).toLocaleString('ru-RU')} мин`;
    }

    dailyCacheScheduleFromSettings(settings = this.adminCacheSettings) {
        if (!settings.cacheCleanEnabled)
            return '';
        if (settings.cacheCleanFrequency === 'interval')
            return undefined; // Omit the cron override to keep using the server interval.
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

    formatMilliseconds(value = 0) {
        const ms = Number(value);
        if (!Number.isFinite(ms) || ms <= 0)
            return '0 ms';
        if (ms < 1000)
            return `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;

        return `${(ms / 1000).toFixed(1)} s`;
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
        const parts = [];

        if (limit !== null && limit !== undefined)
            parts.push(`Лимит: ${this.formatBytes(limit)}`);
        if (target !== null && target !== undefined)
            parts.push(this.adminCacheTargetText(target));

        return parts.filter(Boolean).join(' · ');
    }

    adminCacheRotationValue() {
        const limits = (this.adminDashboard && this.adminDashboard.limits) || {};
        if (this.hasCacheInterval(limits))
            return this.cacheIntervalLabel(limits);
        const schedule = String(limits.cacheCleanSchedule || '').trim();
        const parsed = this.parseAdminCacheSchedule(schedule);
        if (!parsed.enabled)
            return 'Отключена';
        if (parsed.advancedSchedule)
            return 'По cron';
        if (parsed.frequency === 'weekly')
            return 'Раз в неделю';
        if (parsed.frequency === 'monthly')
            return 'Раз в месяц';

        return 'Каждый день';
    }

    adminCacheRotationHint() {
        const limits = (this.adminDashboard && this.adminDashboard.limits) || {};
        const schedule = String(limits.cacheCleanSchedule || '').trim();
        const parsed = this.parseAdminCacheSchedule(schedule);
        const nextRun = this.formatServerDateTime(limits.cacheCleanNextRunAt, limits.cacheCleanServerTimeZone);
        const parts = [];

        if (parsed.enabled && !parsed.advancedSchedule) {
            if (parsed.frequency === 'weekly')
                parts.push(`${this.adminCacheWeekDayLabel(parsed.weekDay)}, ${parsed.time}`);
            else if (parsed.frequency === 'monthly')
                parts.push(`${parsed.monthDay} число, ${parsed.time}`);
            else
                parts.push(parsed.time);
        } else if (parsed.advancedSchedule) {
            parts.push(schedule);
        }
        if (nextRun)
            parts.push(`Следующая: ${nextRun}`);
        if (limits.cacheCleanServerTimeZone)
            parts.push(limits.cacheCleanServerTimeZone);

        return parts.join(' · ');
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

    get adminCpuText() {
        const cpu = (this.adminDashboard && this.adminDashboard.cpu) || {};
        const percent = Number.isFinite(Number(cpu.currentPercent)) ? Number(cpu.currentPercent) : Number(cpu.averagePercent);
        if (!Number.isFinite(percent))
            return '0%';

        return `${percent.toFixed(percent >= 10 ? 0 : 1)}%`;
    }

    get adminCpuHint() {
        const cpu = (this.adminDashboard && this.adminDashboard.cpu) || {};
        const average = Number(cpu.averagePercent);
        const averageText = Number.isFinite(average) ? `Среднее: ${average.toFixed(average >= 10 ? 0 : 1)}% · ` : '';
        const totalSeconds = Number(cpu.totalSeconds);
        const totalText = Number.isFinite(totalSeconds) ? `CPU-время: ${this.formatDuration(totalSeconds)}` : '';
        return `${averageText}${totalText}`.trim();
    }

    get adminRuntime() {
        return (this.adminDashboard && this.adminDashboard.runtime) || {};
    }

    get adminActivity() {
        return this.adminDashboard.activity;
    }

    get adminDiscovery() {
        return (this.adminDashboard && this.adminDashboard.discovery) || {};
    }

    discoveryMetric(key = '') {
        return Number((this.adminDiscovery.totals || {})[key]) || 0;
    }

    discoveryRateText(key = '') {
        const rate = Number((this.adminDiscovery.rates || {})[key]) || 0;
        return `${(rate * 100).toFixed(rate >= 0.1 ? 0 : 1)}%`;
    }

    get adminRuntimeHint() {
        const inFlight = Number(this.adminRuntime.inFlightActions || 0);
        const actionCount = Number(this.adminRuntime.actionCount || 0);
        return `${inFlight} выполняется · ${actionCount} типов`;
    }

    get runtimeLagText() {
        return this.formatMilliseconds(this.adminRuntime.lastEventLoopLagMs);
    }

    get runtimeLagHint() {
        return `p95: ${this.formatMilliseconds(this.adminRuntime.eventLoopLagP95Ms)}`;
    }

    get runtimeLastSlowActionText() {
        const slow = this.adminRuntime.lastSlowAction || {};
        return slow.action || 'нет';
    }

    get runtimeLastSlowActionHint() {
        const slow = this.adminRuntime.lastSlowAction || {};
        if (!slow.action)
            return 'Порог: 1.5 s';

        const time = slow.at ? this.formatDateTime(slow.at) : '';
        return `${this.formatMilliseconds(slow.durationMs)}${time ? ` · ${time}` : ''}`;
    }

    get runtimeSlowestActions() {
        return Array.isArray(this.adminRuntime.slowestActions) ? this.adminRuntime.slowestActions : [];
    }

    actionDurationText(item = {}) {
        return `p95 ${this.formatMilliseconds(item.p95Ms)} · max ${this.formatMilliseconds(item.maxMs)} · ${item.count || 0}`;
    }

    get adminIndex() {
        return (this.adminDashboard && this.adminDashboard.index) || {};
    }

    get adminIndexBusy() {
        const state = String(this.adminIndex.state || '');
        return this.adminIndex.updating === true || state === 'db_creating' || state === 'db_loading'
            || (this.adminReindexInProgress && this.adminIndex.ready !== true);
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
            type: source.type === 'folder' ? 'folder' : 'inpx',
            id: String(source.id || '').trim(),
            name: String(source.name || '').trim(),
            inpx: String(source.inpx || '').trim(),
            libDir: String(source.libDir || '').trim(),
            enabled: source.enabled !== false,
        };
    }

    syncAdminSources() {
        const sources = (this.adminDashboard && this.adminDashboard.sources) || this.config.adminLibrarySources || [];
        this.adminSources = sources.map(source => ({
            id: source.id || '',
            name: source.name || '',
            inpx: source.inpx || '',
            type: source.type === 'folder' ? 'folder' : 'inpx',
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
        if (!this.adminExpanded) {
            this.stopAdminMetricsPolling();
            return;
        }

        if (!this.adminDashboard.generatedAt)
            await this.loadAdminPanel();
        else
            this.startAdminMetricsPolling();
    }

    async loadAdminPanel() {
        this.adminLoading = true;
        try {
            await this.refreshAdminDashboard(true);
            if (this.adminDashboardAvailable) {
                this.refreshAdminEvents();
                this.startAdminMetricsPolling();
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminLoading = false;
        }
    }

    async refreshAdminDashboard(syncSources = false) {
        if (this.adminDashboardAvailable) {
            this.adminDashboard = await this.api.getAdminDashboard();
        } else {
            const status = await this.api.request({action: 'get-worker-state', workerId: 'server_state'});
            this.adminDashboard = {index: {...status, ready: status.state === 'normal' && !status.updating}};
        }
        this.syncAdminCacheSettings();
        if (syncSources)
            this.syncAdminSources();
    }

    get adminDashboardAvailable() {
        return !this.config.adminCache || this.config.clientApi?.features?.includes('adminDashboard');
    }

    async refreshAdminMetrics() {
        const metrics = await this.api.getAdminDashboardMetrics();
        this.adminDashboard = Object.assign({}, this.adminDashboard, metrics);
    }

    startAdminMetricsPolling(delay = 5000) {
        this.stopAdminMetricsPolling();
        if (!this.dialogVisible || !this.adminExpanded)
            return;

        this.adminMetricsPollTimer = setTimeout(async() => {
            this.adminMetricsPollTimer = null;
            if (!this.dialogVisible || !this.adminExpanded)
                return;

            if (this.adminMetricsPollInFlight || this.adminIndexBusy || this.adminReindexInProgress) {
                this.startAdminMetricsPolling();
                return;
            }

            this.adminMetricsPollInFlight = true;
            try {
                await this.refreshAdminMetrics();
                await this.refreshAdminEvents({quiet: true});
            } catch (e) {
                // Keep the settings panel quiet; the next tick or manual refresh can recover.
            } finally {
                this.adminMetricsPollInFlight = false;
            }

            if (this.dialogVisible && this.adminExpanded)
                this.startAdminMetricsPolling();
        }, delay);
    }

    stopAdminMetricsPolling() {
        if (!this.adminMetricsPollTimer)
            return;

        clearTimeout(this.adminMetricsPollTimer);
        this.adminMetricsPollTimer = null;
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
                    if (this.adminReindexInProgress && this.adminIndex.ready)
                        await this.api.updateConfig({skipProfileLogin: true});
                    this.adminReindexInProgress = false;
                    if (this.adminDashboardAvailable)
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

    async refreshAdminEvents(options = {}) {
        const quiet = options.quiet === true;
        const requestId = ++this.adminEventsRequestId;
        if (!quiet)
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
            if (!quiet && requestId === this.adminEventsRequestId)
                this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            if (!quiet)
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
            type: 'inpx',
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
            if (result.rebuilt === false) {
                this.$root.notify.info('В источнике книги не найдена новая обложка.');
                return;
            }
            this.$root.notify.success(result.rebuilt ? 'Обложка пересобрана.' : this.adminUi.coverRebuildStarted);
            if (result.coverUrl) {
                const cover = new URL(result.coverUrl, window.location.href);
                cover.searchParams.set('t', Date.now());
                (new Image()).src = cover.href;
            }
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.adminCoverRebuildLoading = false;
        }
    }

    async reindexAdmin() {
        this.adminReindexLoading = true;
        try {
            const result = await this.api.adminReindex();
            if (result.started === false)
                throw new Error('Индекс уже обновляется. Повторите после завершения.');
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
            const patch = {...this.integrations};
            // Hidden custom drafts must not block direct/environment routing.
            // Omitted fields preserve the server's saved custom connection.
            if (patch.telegramProxyMode !== 'custom')
                for (const key of Object.keys(patch))
                    if (key.startsWith('telegramProxy') && key !== 'telegramProxyMode') delete patch[key];
            const result = await this.api.updateAdminIntegrations(patch);
            if (result && result.integrations)
                this.integrations = this.integrationValues(result.integrations);
            this.telegramProxyPasswordVisible = false;
            await this.api.updateConfig();
            if (!options.quiet)
                this.$root.notify.success(this.mailUi.saved);
            await this.$refs?.telegramBotStatus?.refresh?.();
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
        this.telegramNotice?.(); this.telegramNotice = null;
        const saved = await this.saveIntegrations({quiet: true});
        if (!saved)
            return;

        this.telegramTestLoading = true;
        try {
            const result = await this.api.testAdminIntegration('telegram');
            const status = await this.$refs?.telegramBotStatus?.refresh?.() || result?.telegramBotStatus;
            const notice = telegramProbeNotice(result,status,this.integrations.telegramBotEnabled);
            this.telegramNotice = this.$root.notify[notice.kind](notice.message,notice.caption);
        } catch (e) {
            await this.$refs?.telegramBotStatus?.refresh?.();
            this.telegramNotice = this.$root.notify.error('Не удалось проверить подключение к Telegram',e.message);
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

    async onSettingsImportSelected(event) {
        const input = event && event.target;
        const file = input && input.files && input.files[0];
        if (!file)
            return;

        this.settingsImportLoading = true;
        try {
            const data = JSON.parse(await file.text());
            const result = await this.api.importAdminSettings(data);
            await this.api.updateConfig();
            this.loadSettings();
            this.adminSourcesReindexNeeded = this.adminSourcesReindexNeeded || result.reindexRequired === true;
            this.$root.notify.success(result.restartRequired ? 'Настройки восстановлены. Для части настроек нужен перезапуск сервера.' : 'Настройки восстановлены');
        } catch (e) {
            this.$root.stdDialog.alert(e.message, this.mailUi.errorTitle);
        } finally {
            this.settingsImportLoading = false;
            if (input)
                input.value = '';
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
    display: grid;
    gap: 8px;
    min-width: 0;
    color: var(--app-text);
    font-size: 14px;
}
.settings-heading {
    margin: 12px 0 2px;
    color: var(--app-muted);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
}
.settings-group, .settings-task-link, .admin-mail-box {
    min-width: 0;
    border: 1px solid var(--app-border);
    border-radius: 12px;
    background: var(--app-surface);
}
.settings-group > summary, .settings-task-link, .admin-collapse-head {
    display: flex;
    box-sizing: border-box;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 48px;
    padding: 10px 14px;
    color: inherit;
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
}
.settings-group > summary {list-style: none; border-radius: inherit;}
.settings-group > summary::-webkit-details-marker {display: none;}
.settings-group > summary::after {
    content: '';
    width: 8px;
    height: 8px;
    margin: 0 5px 3px auto;
    flex-shrink: 0;
    border: solid var(--app-muted);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
}
.settings-group[open] > summary::after {transform: rotate(225deg); margin-bottom: -4px;}
.settings-group > summary:hover, .settings-task-link:hover, .admin-collapse-head:hover {background: var(--app-surface-2);}
.settings-task-link:focus-visible, .admin-collapse-head:focus-visible, .settings-group > summary:focus-visible {
    outline: 2px solid var(--app-primary);
    outline-offset: -2px;
}
.settings-group > summary .q-icon, .settings-task-link .q-icon, .settings-icon {color: var(--app-primary); font-size: 20px;}
.settings-task-link .q-icon:last-child {margin-left: auto; color: var(--app-muted);}
.settings-group-body {
    display: grid;
    gap: 8px;
    padding: 12px 14px 14px;
    border-top: 1px solid var(--app-border);
}
.settings-checks, .settings-fields {
    display: grid;
    gap: 4px 16px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}
.settings-fields {align-items: center; gap: 12px 16px;}
.settings-checks :deep(.q-checkbox) {min-height: 40px; min-width: 0;}
.settings-divider {border-top: 1px solid var(--app-border); padding-top: 8px;}
.settings-card-view {display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px;}
.settings-card-view-toggle {background: var(--app-surface-2); border-radius: 8px;}
.settings-source-name {display: block; color: var(--app-muted); font-size: 12px; font-weight: 400; overflow-wrap: anywhere;}
@media (max-width: 599px) {
    .settings-checks, .settings-fields {grid-template-columns: minmax(0, 1fr);}
    .settings-group-body {padding: 10px;}
}

.admin-collapse-box {
    padding: 0;
    overflow: hidden;
}

.admin-collapse-head {border: 0; background: transparent;}

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
.admin-collapse-head .admin-mail-title {font: inherit;}

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

.admin-dashboard-sections {
    display: grid;
    gap: 14px;
    margin-top: 12px;
}

.admin-dashboard-section {
    display: grid;
    gap: 8px;
}

.admin-dashboard-section-title {
    color: var(--app-muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0;
}

.admin-dashboard-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
}

.admin-dashboard-grid--compact {
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

.admin-dashboard-grid--storage {
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

.admin-dashboard-grid--runtime {
    grid-template-columns: repeat(3, minmax(0, 1fr));
}

.admin-dashboard-grid--activity {
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.admin-activity-title {
    margin: 0;
    line-height: inherit;
}

.admin-activity-details {
    min-width: 0;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: var(--app-surface);
    font-size: 12px;
}

.admin-activity-details summary {
    padding: 8px 10px;
    color: var(--app-primary);
    cursor: pointer;
}

.admin-activity-details > summary:focus {
    outline: none;
}

.admin-activity-details > summary:focus-visible span {
    outline: 2px solid var(--app-primary);
    outline-offset: 2px;
    border-radius: 2px;
}

.admin-activity-name {
    display: block;
    color: var(--app-muted);
}

.admin-activity-scroll {
    max-height: 220px;
    overflow: auto;
}

.admin-activity-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
}

.admin-activity-table th,
.admin-activity-table td {
    padding: 6px 10px;
    border-top: 1px solid var(--app-border);
    text-align: right;
}

.admin-activity-table th:first-child {
    text-align: left;
    overflow-wrap: anywhere;
}

.admin-activity-table thead {
    color: var(--app-muted);
}

.admin-activity-table tbody th {
    font-weight: normal;
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

.admin-stat-value--small {
    font-size: 14px;
}

.admin-stat-hint {
    margin-top: 4px;
    color: var(--app-muted);
    font-size: 11px;
    line-height: 1.25;
    overflow-wrap: anywhere;
}

.admin-runtime-list {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--app-border);
    border-radius: 10px;
    background: var(--app-surface);
}

.admin-runtime-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    color: var(--app-muted);
    font-size: 12px;
}

.admin-runtime-action {
    min-width: 0;
    overflow: hidden;
    color: var(--app-text);
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.admin-runtime-value {
    white-space: nowrap;
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
        grid-template-columns: minmax(0, 1fr);
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
