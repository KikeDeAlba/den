#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: build:mac only runs on macOS" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

want_dmg=0
for arg in "$@"; do
  case "$arg" in
    --dmg) want_dmg=1 ;;
    *)
      echo "error: unsupported argument '$arg' (only --dmg is accepted)" >&2
      exit 1
      ;;
  esac
done

allow_adhoc="${DEN_ALLOW_ADHOC:-}"
if [[ -n "$allow_adhoc" && "$allow_adhoc" != "1" ]]; then
  echo "error: DEN_ALLOW_ADHOC must be unset or 1" >&2
  exit 1
fi

identity="${DEN_SIGN_IDENTITY:-}"
if [[ -n "$identity" && "$identity" != "-" && ! "$identity" =~ ^[0-9A-Fa-f]{40}$ ]]; then
  echo "error: DEN_SIGN_IDENTITY must be a 40-character hex certificate hash, or - with DEN_ALLOW_ADHOC=1" >&2
  exit 1
fi
if [[ "$identity" == "-" && "$allow_adhoc" != "1" ]]; then
  echo "error: DEN_SIGN_IDENTITY=- (ad hoc) requires DEN_ALLOW_ADHOC=1" >&2
  exit 1
fi
identity="$(printf '%s' "$identity" | tr 'a-f' 'A-F')"

if [[ "$identity" != "-" ]]; then
  listing="$(security find-identity -v -p codesigning)"
  if [[ -z "$identity" ]]; then
    candidates="$(printf '%s\n' "$listing" | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "Apple Development: .*/\1/p' | sort -u)"
    count="$(printf '%s' "$candidates" | grep -c . || true)"
    if [[ "$count" -gt 1 ]]; then
      echo "error: several Apple Development identities found; set DEN_SIGN_IDENTITY to the hash of the one Recap.app uses:" >&2
      printf '%s\n' "$candidates" >&2
      exit 1
    fi
    identity="$candidates"
  else
    line="$(printf '%s\n' "$listing" | grep "^ *[0-9]*) $identity " || true)"
    if [[ -z "$line" ]]; then
      echo "error: identity $identity is not a valid code signing identity in the keychain" >&2
      exit 1
    fi
    if [[ "$line" != *"\"Apple Development: "* ]]; then
      echo "error: identity $identity is not an Apple Development certificate" >&2
      exit 1
    fi
  fi
  if [[ -z "$identity" ]]; then
    if [[ "$allow_adhoc" == "1" ]]; then
      identity="-"
    else
      echo "error: no Apple Development identity found; set DEN_SIGN_IDENTITY, or DEN_ALLOW_ADHOC=1 to sign ad hoc" >&2
      exit 1
    fi
  fi
fi

if [[ "$identity" == "-" && "$want_dmg" == "1" ]]; then
  echo "error: --dmg produces a distributable build and cannot be signed ad hoc" >&2
  exit 1
fi

work="$(mktemp -d)"
mount_point=""
cleanup() {
  if [[ -n "$mount_point" ]]; then
    hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || hdiutil detach -force "$mount_point" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

if [[ "$identity" != "-" ]]; then
  for recap in "$HOME/Applications/Recap.app" "/Applications/Recap.app"; do
    if [[ -d "$recap" ]]; then
      mkdir "$work/recap"
      (cd "$work/recap" && codesign -d --extract-certificates "$recap" >/dev/null 2>&1) || true
      if [[ -f "$work/recap/codesign0" ]]; then
        recap_leaf="$(openssl x509 -inform DER -in "$work/recap/codesign0" -noout -fingerprint -sha1 | sed 's/^.*=//; s/://g' | tr 'a-f' 'A-F')"
        if [[ "$recap_leaf" != "$identity" ]]; then
          echo "warning: Recap.app is signed with a different certificate (${recap_leaf:0:8}...) than this build (${identity:0:8}...); permissions will not carry over" >&2
        fi
      fi
      break
    fi
  done
fi

if [[ "$identity" == "-" ]]; then
  echo "warning: signing ad hoc; permissions will be requested again after each build" >&2
fi

unset TAURI_CONFIG TAURI_APP_PATH TAURI_FRONTEND_PATH TAURI_CLI_CONFIG_DEPTH \
  TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PATH TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  TAURI_SKIP_SIDECAR_SIGNATURE_CHECKS \
  APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID \
  APPLE_DEVELOPMENT_TEAM APPLE_PROVIDER_SHORT_NAME APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH \
  CARGO_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_TARGET MACOSX_DEPLOYMENT_TARGET
export APPLE_SIGNING_IDENTITY="$identity"

bundle_dir="src-tauri/target/release/bundle"
app="$bundle_dir/macos/Den.app"
rm -rf "$app" "$bundle_dir/dmg"

bundles="app"
if [[ "$want_dmg" == "1" ]]; then
  bundles="app,dmg"
fi
pnpm tauri build --bundles "$bundles"

if [[ ! -d "$app" ]]; then
  echo "error: expected bundle not found at $app" >&2
  exit 1
fi
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")"
if [[ "$bundle_id" != "com.kikedealba.den" ]]; then
  echo "error: unexpected bundle identifier '$bundle_id'" >&2
  exit 1
fi

verify_app() {
  local target="$1" details expected actual
  codesign --verify --deep --strict "$target"
  details="$(codesign -d --verbose=2 "$target" 2>&1)"
  if ! printf '%s\n' "$details" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\(.*runtime'; then
    echo "error: hardened runtime flag is missing from the signature" >&2
    return 1
  fi
  if [[ "$identity" == "-" ]]; then
    return 0
  fi
  expected="$(tr -d '\n' < scripts/designated-requirement.txt)"
  actual="$(codesign -d -r- "$target" 2>&1 | sed -n 's/^designated => //p')"
  case "$actual" in
    "$expected"*) ;;
    *)
      echo "error: designated requirement does not start with the expected one" >&2
      return 1
      ;;
  esac
  if ! codesign --verify --strict -R "=$expected and certificate leaf = H\"$identity\"" "$target"; then
    echo "error: signature does not satisfy the expected requirement with leaf $identity" >&2
    return 1
  fi
}

verify_app "$app"
if [[ "$identity" == "-" ]]; then
  echo "$app (signed ad hoc)"
else
  echo "$app (signed with identity ${identity:0:8}..., requirement and runtime verified)"
fi

if [[ "$want_dmg" == "1" ]]; then
  dmg="$(find "$bundle_dir/dmg" -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"
  if [[ -z "$dmg" ]]; then
    echo "error: --dmg requested but no .dmg was produced in $bundle_dir/dmg" >&2
    exit 1
  fi
  mount_point="$work/mnt"
  mkdir "$mount_point"
  hdiutil attach -readonly -nobrowse -noverify -mountpoint "$mount_point" "$dmg" >/dev/null
  if [[ ! -d "$mount_point/Den.app" ]]; then
    echo "error: Den.app not found inside $dmg" >&2
    exit 1
  fi
  verify_app "$mount_point/Den.app"
  echo "$dmg (app inside verified with identity ${identity:0:8}...)"
fi
