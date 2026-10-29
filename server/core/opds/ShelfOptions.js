function normalize(value = {}) {
    return {pinned:value?.pinned === true, grouping:['authors', 'series'].includes(value?.grouping) ? value.grouping : 'books'};
}

module.exports = {normalize};
