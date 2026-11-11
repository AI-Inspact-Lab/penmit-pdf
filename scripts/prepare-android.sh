#!/usr/bin/env bash
# Builds the Capacitor Android project from web/ (run from the repository root, after
# `npm install` in mobile/). Used by .github/workflows/release.yml; also works locally:
#   (cd mobile && npm install) && scripts/prepare-android.sh 0.1.0 1
set -euo pipefail

VERSION="${1:?version, e.g. 0.1.0}"
CODE="${2:?version code, a whole number that grows with every release}"
cd "$(dirname "$0")/../mobile"

# 1. The web app, plus Capacitor's runtime for the save/share bridge (see web/src/platform.js).
rm -rf www
cp -r ../web www
mkdir -p www/vendor/capacitor
cp node_modules/@capacitor/core/dist/index.js www/vendor/capacitor/core.js
rm -f www/sw.js
# Capacitor injects its bridge as an inline script; allow inline scripts inside the app only.
sed -i.bak "s/script-src 'self'/script-src 'self' 'unsafe-inline'/" www/index.html && rm -f www/index.html.bak

# 2. The native project.
[ -d android ] || npx cap add android
npx cap sync android

# 3. Version and launcher icons.
GRADLE=android/app/build.gradle
sed -i.bak -E "s/versionCode [0-9]+/versionCode ${CODE}/; s/versionName \"[^\"]*\"/versionName \"${VERSION}\"/" "$GRADLE" && rm -f "$GRADLE.bak"
cp -r android-res/. android/app/src/main/res/

grep -E "versionCode|versionName" "$GRADLE"
