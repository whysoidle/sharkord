#!/bin/sh
set -eu
process_id=$1
staged_app=$2
target_app=$3
counter=0
while kill -0 "$process_id" 2>/dev/null; do
    counter=$((counter + 1))
    [ "$counter" -lt 150 ] || exit 1
    sleep 0.2
done
next_app="${target_app}.new-$$"
previous_app="${target_app}.previous-$$"
/usr/bin/ditto "$staged_app" "$next_app"
/usr/bin/codesign --verify --deep --strict "$next_app"
/bin/mv "$target_app" "$previous_app"
if /bin/mv "$next_app" "$target_app"; then
    /usr/bin/open "$target_app"
else
    /bin/mv "$previous_app" "$target_app"
    /usr/bin/open "$target_app"
    exit 1
fi
