// JSON Lines uses LF as its delimiter. U+2028 and U+2029 are valid inside book titles.
module.exports = async function* readJsonLines(stream) {
    let pending = '';
    for await (const chunk of stream.setEncoding('utf8')) {
        const lines = chunk.split('\n');
        lines[0] = pending + lines[0];
        pending = lines.pop();
        for (const line of lines) yield JSON.parse(line);
    }
    if (pending) yield JSON.parse(pending);
};
