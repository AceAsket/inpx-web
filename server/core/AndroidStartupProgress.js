'use strict';

const fs = require('node:fs');
const path = require('node:path');

let previous = '', previousStage = '', changedAt = 0;

// This file stays readable by Android even if Node's event loop no longer serves HTTP.
function publish(state) {
    const directory = process.env.INPX_ANDROID_DATA_DIR;
    if (!directory) return;
    const ready = state.state === 'normal';
    const progress = state.progress;
    const record = {
        pid: process.pid,
        stage: ready ? 'Сервер в сети' : state.jobMessage || state.serverMessage,
        detail: state.job === 'load inpx'
            ? [state.sourceName, state.fileName].filter(Boolean).join(' · ')
            : state.tableRows > 0 && state.job?.endsWith(' save') ? `Строк в таблице: ${state.tableRows}` : '',
        percent: state.jobStep > 0 && Number.isFinite(progress) ? Math.round(100 * progress) : -1,
        step: state.jobStep || 0,
        steps: state.jobStepCount || 0,
        records: state.recsLoaded || 0,
        ready,
    };
    const signature = JSON.stringify(record);
    const now = Date.now();
    if (signature === previous || (record.stage === previousStage && now - changedAt < 750)) return;
    const file = path.join(directory, 'startup-progress.json');
    try {
        fs.writeFileSync(file + '.tmp', JSON.stringify({...record, changedAt: now}));
        fs.renameSync(file + '.tmp', file);
        previous = signature;
        previousStage = record.stage;
        changedAt = now;
    } catch { /* Diagnostics cannot interrupt an index build. */ }
}

module.exports = {publish};
