'use strict';

function semanticNode({
  nodeId,
  sourceIndex,
  rawTreeId,
  screenshotId = null,
  role,
  text = null,
  label = null,
  bounds = null,
  enabled = true,
  checked = null,
  selected = null,
  clickable = false,
}) {
  return {
    nodeId: String(nodeId),
    sourceIndex,
    rawTreeId,
    screenshotId,
    role,
    text,
    label,
    bounds,
    enabled,
    checked,
    selected,
    clickable,
  };
}

module.exports = { semanticNode };
