'use strict';

// Android images expose the same SHA-256 operation as either a standalone tool
// or a toybox/busybox applet. Select by an actual digest, not ROM or API level.
const sha256Shell = `aab_sha256sum() {
  case "$aab_sha256_provider" in
    native) command sha256sum "$@";;
    toybox) command toybox sha256sum "$@";;
    busybox) command busybox sha256sum "$@";;
  esac
}
aab_select_sha256() {
  for aab_sha256_provider in native toybox busybox; do
    aab_sha256_probe=$(aab_sha256sum /dev/null 2>/dev/null) || continue
    [ "\${aab_sha256_probe%% *}" = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ] && return 0
  done
  printf '%s\\n' 'SHA-256 unavailable: sha256sum, toybox sha256sum and busybox sha256sum were tried.' >&2
  return 127
}
`;

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function sha256FileScript(file) {
  return `${sha256Shell}aab_select_sha256 || exit 127\naab_sha256sum ${quote(file)}`;
}

module.exports = { sha256Shell, sha256FileScript };
