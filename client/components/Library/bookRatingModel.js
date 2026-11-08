// Share formatters across all covers on the page, rather than allocating Intl
// objects for each book. Ratings here never trigger metadata requests.
const decimal = new Intl.NumberFormat('ru', {maximumFractionDigits:1});
const integer = new Intl.NumberFormat('ru');
const plural = new Intl.PluralRules('ru');
const numeric = value => ['number','string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value));
const validScore = value => numeric(value) && Number(value) > 0 && Number(value) <= 5;

function bookRating(book = {}) {
    if (book.del) return null;
    const detailed = validScore(book.libraryRating?.value);
    const value = detailed ? book.libraryRating.value : book.librate;
    if (!validScore(value)) return null;
    const score = decimal.format(Number(value));
    const rawCount = detailed ? book.libraryRating.count : book.ratingCount;
    const count = numeric(rawCount) && Number.isSafeInteger(Number(rawCount)) && Number(rawCount) > 0 ? Number(rawCount) : 0;
    const compact = count >= 1000000 ? decimal.format(count / 1000000) + 'м' : count >= 1000 ? decimal.format(count / 1000) + 'к' : String(count);
    const unit = {one:'оценка',few:'оценки',many:'оценок',other:'оценки'}[plural.select(count)];
    return {score, count:count ? compact : '', description:`${detailed ? 'Оценка читателей' : 'Оценка библиотеки'}: ${score} из 5${count ? ` · ${integer.format(count)} ${unit}` : ''}`};
}
module.exports={bookRating};
