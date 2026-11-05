#!/bin/bash
# Fallback when the native window can't be compiled (e.g. packaging on Linux): register the service, then open in the browser
exec "$(dirname "$0")/../Resources/kiki-setup" --open
