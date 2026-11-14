function createTopRanked(limit, compare) {
    const heap = [];
    function moveDown() {
        let index = 0;
        while (true) {
            const left = index * 2 + 1;
            const right = left + 1;
            let worst = index;
            if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
            if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
            if (worst === index) return;
            [heap[index], heap[worst]] = [heap[worst], heap[index]];
            index = worst;
        }
    }

    return {
        add(item) {
            if (limit <= 0) return;
            if (heap.length >= limit) {
                if (compare(item, heap[0]) < 0) {
                    heap[0] = item;
                    moveDown();
                }
                return;
            }

            let index = heap.push(item) - 1;
            while (index > 0) {
                const parent = (index - 1) >> 1;
                if (compare(heap[index], heap[parent]) <= 0) break;
                [heap[index], heap[parent]] = [heap[parent], heap[index]];
                index = parent;
            }
        },
        ranked() {
            return heap.sort(compare);
        },
    };
}

// Exact prefix of the full sort, expanding only when author/series diversity needs more rows.
function selectDiverseBest(rows, compare, limit) {
    const total = rows.size;
    let size = Math.min(total, Math.max(64, limit * 8));
    while (true) {
        const top = createTopRanked(size, compare);
        for (const row of rows.values()) top.add(row);

        const selected = [], authors = new Map(), series = new Map();
        for (const row of top.ranked()) {
            const author = String(row.author || '').trim().toLowerCase();
            const name = String(row.series || '').trim().toLowerCase();
            if (author && (authors.get(author) || 0) >= 2 || name && (series.get(name) || 0) >= 2) continue;
            selected.push(row);
            if (author) authors.set(author, (authors.get(author) || 0) + 1);
            if (name) series.set(name, (series.get(name) || 0) + 1);
            if (selected.length >= limit) return selected;
        }
        if (size >= total) return selected;
        size = Math.min(total, size * 2);
    }
}

// Jemba evaluates the selection function in the database worker.
const selectDiverseBestSource = `(() => {
    const createTopRanked = ${createTopRanked.toString()};
    return ${selectDiverseBest.toString()};
})()`;

module.exports = {createTopRanked, selectDiverseBest, selectDiverseBestSource};
