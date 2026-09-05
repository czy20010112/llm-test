function tailLines(value) {
  return String(value || '').replace(/\r/g, '').trim().split('\n').slice(-8).reverse();
}

function extractChoice(value) {
  for (const line of tailLines(value)) {
    const boxed = line.match(/\\boxed\s*\{\s*(?:\\text\s*\{\s*)?([A-J])\b/i);
    if (boxed) return boxed[1].toUpperCase();
    const labeled = line.match(/(?:最终答案|最终选项|final\s+answer|final\s+choice)\s*(?:是|为|is|:|：)?\s*\(?\s*([A-J])\b/i);
    if (labeled) return labeled[1].toUpperCase();
    const standalone = line.match(/^\s*[\(\[]?\s*([A-J])\s*[\)\].。]?\s*$/i);
    if (standalone) return standalone[1].toUpperCase();
  }
  return null;
}

function scoreChoice(expected, output) {
  const answer = extractChoice(output);
  if (!answer) return { status: 'unknown', answer: null };
  return { status: answer === String(expected || '').trim().toUpperCase() ? 'correct' : 'incorrect', answer };
}

function extractAime(value) {
  for (const line of tailLines(value)) {
    const boxed = line.match(/\\boxed\s*\{\s*(-?\d{1,3})\s*\}/i);
    if (boxed) return String(Number(boxed[1]));
    const labeled = line.match(/(?:最终答案|final\s+answer|final\s+value)\s*(?:是|为|is|:|：)?\s*(?:\\boxed\s*\{\s*)?(-?\d{1,3})/i);
    if (labeled) return String(Number(labeled[1]));
    const standalone = line.match(/^\s*(-?\d{1,3})\s*[。.]?\s*$/);
    if (standalone) return String(Number(standalone[1]));
  }
  return null;
}

function scoreAime(expected, output) {
  const answer = extractAime(output);
  if (!answer) return { status: 'unknown', answer: null };
  const normalizedExpected = String(Number(expected));
  return { status: answer === normalizedExpected ? 'correct' : 'incorrect', answer };
}

function aggregateScore({ correct = 0, incorrect = 0, unknown = 0, total } = {}) {
  const denominator = Number.isFinite(total) ? total : correct + incorrect + unknown;
  return denominator > 0 ? correct / denominator : 0;
}

module.exports = { extractChoice, scoreChoice, extractAime, scoreAime, aggregateScore };
