#!/bin/bash
# Remove the Media Saver native-messaging host manifest -- that one file only.
# Other manifests in the NativeMessagingHosts folder are left untouched.
set -euo pipefail

MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mediasaver.helper.json"
if [ -e "$MANIFEST" ] || [ -L "$MANIFEST" ]; then
  rm -f -- "$MANIFEST"
  echo "removed $MANIFEST"
else
  echo "not installed: $MANIFEST"
fi
