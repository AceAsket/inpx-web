// Order is significant. Keep entries for temporarily unavailable sources and lists.
function normalize(value) {
    const seen = new Set(), rows = [];
    for (const row of Array.isArray(value) ? value : []) {
        const id = row?.id;
        if (typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
        rows.push({id, hidden: row.hidden === true});
        seen.add(id);
        if (rows.length === 256) break;
    }
    return rows;
}

function arrange(shelves, layout) {
    const available = new Map(shelves.map(shelf => [shelf.id, shelf]));
    const ordered = [];
    for (const row of normalize(layout)) {
        const shelf = available.get(row.id);
        if (!shelf) continue;
        ordered.push({...shelf, hidden: row.hidden});
        available.delete(row.id);
    }
    return ordered.concat(Array.from(available.values()));
}

module.exports = {normalize, arrange};
