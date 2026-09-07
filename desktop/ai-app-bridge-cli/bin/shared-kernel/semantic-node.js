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
  resourceName,
  editable,
  visible,
  effectiveVisible,
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
    ...(typeof resourceName === 'string' ? { resourceName } : {}),
    ...(typeof editable === 'boolean' ? { editable } : {}),
    ...(typeof visible === 'boolean' ? { visible } : {}),
    ...(typeof effectiveVisible === 'boolean' ? { effectiveVisible } : {}),
  };
}

module.exports = { semanticNode };
