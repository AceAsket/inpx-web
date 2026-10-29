function arm(value, now = Date.now()) {
    if (value === 'chapter') return {kind:'chapter',deadline:0};
    const minutes = Number(value);
    return [15,30,60].includes(minutes) ? {kind:'time',deadline:now + minutes * 60000} : {kind:'off',deadline:0};
}
function expired(timer, now = Date.now()) { return timer?.kind === 'time' && now >= timer.deadline; }
function chapterEnded(timer, part) {return timer?.kind === 'chapter' && part?.chapterEnd !== false;}
module.exports = {arm,expired,chapterEnded};
