#!/bin/bash
# Builds the macOS installer for Liftoff.
# It puts the Audio Unit (Logic, GarageBand) and the VST3 in /Library/Audio/Plug-Ins and the app in /Applications,
# then has macOS pick up the new Audio Unit, so there is nothing to copy or type in Terminal.
# usage: make-pkg.sh <folder with the built bundles> <version> <output .pkg>
set -euo pipefail
src="$1" ver="$2" out="$3"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
root="$work/root"
mkdir -p "$root/Library/Audio/Plug-Ins/Components" "$root/Library/Audio/Plug-Ins/VST3" "$root/Applications" "$work/pkgs" "$work/scripts"
ditto "$src/Liftoff.component" "$root/Library/Audio/Plug-Ins/Components/Liftoff.component"
ditto "$src/Liftoff.vst3" "$root/Library/Audio/Plug-Ins/VST3/Liftoff.vst3"
ditto "$src/Liftoff.app" "$root/Applications/Liftoff.app"

# install to exactly these places, even when another copy of a bundle exists somewhere else on the Mac
plist="$work/components.plist"
pkgbuild --analyze --root "$root" "$plist"
i=0
while /usr/libexec/PlistBuddy -c "Print :$i" "$plist" >/dev/null 2>&1; do
  plutil -replace "$i.BundleIsRelocatable" -bool NO "$plist"   # adds the key when the entry has none
  i=$((i + 1))
done
plutil -p "$plist"

cp "$here/postinstall" "$work/scripts/postinstall"
chmod +x "$work/scripts/postinstall"
pkgbuild --root "$root" --component-plist "$plist" --identifier com.coolprojects404.liftoff --version "$ver" \
  --install-location / --scripts "$work/scripts" "$work/pkgs/Liftoff-core.pkg"
sed "s/@VERSION@/$ver/g" "$here/distribution.xml" > "$work/distribution.xml"
productbuild --distribution "$work/distribution.xml" --resources "$here/resources" --package-path "$work/pkgs" "$out"
rm -rf "$work"
echo "built $out"
