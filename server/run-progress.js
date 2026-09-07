'use strict';

// Keep the question-level checkpoint separate from the aggregate summary.
// The full item map is needed for resume, while the summary is what the UI can
// show immediately when a run is interrupted.
function updateRowCheckpoint(row, liveRepeat, partial) {
  const { items = {}, ...summary } = partial || {};
  row.checkpoint = {
    liveRepeat,
    items: { ...items },
  };
  row.average = { ...summary };
  return row;
}

module.exports = { updateRowCheckpoint };
