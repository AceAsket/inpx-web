const info = Object.freeze({version:1, features:['resumeSession','readerEvents','mobileHome','requestBudget','cancelAudio','bookSearchFormats']});
const expensive = new Set(['search','bookSearch','get-author-book-list','get-author-series-list','get-series-book-list','get-discovery-shelves']);
const readerChanges = new Set(['update-reader-progress','delete-reader-progress','clear-reader-progress','update-reader-preferences',
    'add-reader-bookmark','delete-reader-bookmark','import-reading-lists','import-user-backup','mark-reader-books-read','mark-series-read']);
function client(value) {
    if (!value || value.type !== 'android') return {type:'web',version:''};
    return {type:'android',version:/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.version || '') ? value.version : ''};
}
module.exports = {info,expensive,readerChanges,client};
