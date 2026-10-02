#!/bin/bash

if [ "$#" -ne 1 ]; then
	echo 'ERROR: wrong options given.'
	exit 15
fi

if [ ! -f "$1" ]; then
	echo 'ERROR: file does not exist.'
	exit 15
fi
ARCHIVE=$(readlink -f -- "$1") || {
	echo 'ERROR: cannot resolve archive path.'
	exit 15
}

TEMP=$(mktemp -d "${TMPDIR:-/tmp}/unetlab.XXXXXXXXXX") || {
	echo 'ERROR: cannot create temporary directory.'
	exit 15
}
cleanup() {
	rm -rf -- "$TEMP"
	[ -z "${NEW_ARCHIVE:-}" ] || rm -f -- "$NEW_ARCHIVE"
}
trap cleanup EXIT HUP INT TERM

# Extract the complete archive so nested lab directories and any companion
# files survive the rewrite unchanged.
if ! unzip -q -o -d "$TEMP" "$ARCHIVE"; then
	echo 'ERROR: cannot unzip file.'
	exit 15
fi

if ! find "$TEMP" -type f -name '*.unl' \
	-exec sed -i 's/ id="[0-9a-f-]\{36\}"//g' '{}' +; then
	echo 'ERROR: cannot remove lab UUID.'
	exit 15
fi

# Rebuild rather than update in place. zip -u is timestamp-based and can report
# "nothing to do" when export and UUID removal happen within the same second.
# A sibling temporary file keeps the final replacement on one filesystem.
ARCHIVE_DIR=$(dirname -- "$ARCHIVE")
NEW_ARCHIVE=$(mktemp --tmpdir="$ARCHIVE_DIR" --suffix=.zip .remove_uuid.XXXXXXXX) || {
	echo 'ERROR: cannot create replacement archive.'
	exit 15
}
# Write the new ZIP stream into the already-reserved file. This avoids both
# Info-ZIP's zero-byte-archive handling and an unlink/recreate race.
if ! (cd "$TEMP" && zip -q -r - .) >"$NEW_ARCHIVE"; then
	echo 'ERROR: cannot update files.'
	exit 15
fi
chmod --reference="$ARCHIVE" "$NEW_ARCHIVE" 2>/dev/null || true
if ! mv -f -- "$NEW_ARCHIVE" "$ARCHIVE"; then
	echo 'ERROR: cannot replace archive.'
	exit 15
fi
NEW_ARCHIVE=''

exit 0
