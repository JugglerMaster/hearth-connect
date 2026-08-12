#!/usr/bin/env bash
#
# sd-card-longevity-offline-undo.sh
#
# Revert the SD-card-longevity mitigations (sd-card-longevity.sh) by editing the
# files directly on a Pi SD card that is MOUNTED on another machine — used when
# the Pi itself no longer boots (e.g. overlay read-only root wedged it).
#
# The card must be mounted read-write. Two partitions:
#   ROOT  — the root filesystem  (contains /etc/fstab, /etc/systemd/journald.conf,
#                                 /opt/hearth-pi-agent/config.env)
#   BOOT  — the boot firmware    (contains cmdline.txt: /boot/firmware/cmdline.txt
#                                 on bookworm, or /boot/cmdline.txt on older images)
#
# Usage:
#   sudo bash sd-card-longevity-offline-undo.sh --root /mnt/root --boot /mnt/boot
#
# All edits are idempotent and non-destructive (sed only removes what the
# longevity script added). After reverting, unmount cleanly and boot the Pi.
set -e

ROOT=""
BOOT=""

for a in "$@"; do
  case "$a" in
    --root=*) ROOT="${a#*=}" ;;
    --boot=*) BOOT="${a#*=}" ;;
  esac
done

if [[ -z "$ROOT" || -z "$BOOT" ]]; then
  echo "Usage: sudo $0 --root <mounted root fs> --boot <mounted boot partition>"
  echo "  e.g. sudo $0 --root /mnt/root --boot /mnt/boot"
  exit 1
fi
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }

FSTAB="$ROOT/etc/fstab"
JOURNALD="$ROOT/etc/systemd/journald.conf"
CONFIG="$ROOT/opt/hearth-pi-agent/config.env"
CMDLINE=""
for c in "$BOOT/cmdline.txt" "$BOOT/firmware/cmdline.txt"; do
  [[ -f "$c" ]] && CMDLINE="$c"
done

[[ -f "$FSTAB" ]]    || { echo "ERROR: $FSTAB not found — is ROOT mounted?"; exit 1; }
[[ -f "$JOURNALD" ]] || { echo "ERROR: $JOURNALD not found — is ROOT mounted?"; exit 1; }

echo ">> Reverting on:"
echo "   root=$ROOT  boot=$BOOT"
echo "   cmdline=$CMDLINE"

# ── [2] remove noatime/nodiratime from /boot ──
echo ">> [2] strip noatime from /boot in fstab"
sed -i -E 's#(.*\s/boot[a-z/]*\s+[a-z0-9]+\s+defaults),noatime,nodiratime(.*)#\1\2#' "$FSTAB" || true

# ── [4] remove tmpfs /var/log ──
echo ">> [4] remove tmpfs /var/log"
sed -i '\#tmpfs /var/log #d' "$FSTAB" || true

# ── [5] remove hearth-persist bind + comment ──
echo ">> [5] remove hearth-persist bind mount"
sed -i '/# hearth-persist/d' "$FSTAB" || true
sed -i '\#/opt/hearth-pi-agent /opt/hearth-pi-agent none bind,rw#d' "$FSTAB" || true

# ── [3] journal to persistent ──
echo ">> [3] restore journal to disk"
sed -i 's/^Storage=.*/Storage=persistent/' "$JOURNALD" || true
sed -i '/^RuntimeMaxUse=16M$/d' "$JOURNALD" || true
# If journald.conf had no Storage= line to begin with, the sed above leaves a
# stray line; ensure it is sane.
grep -q '^Storage=' "$JOURNALD" || echo 'Storage=persistent' >> "$JOURNALD"

# ── [5] disable overlay root ──
if [[ -n "$CMDLINE" ]]; then
  echo ">> [5] disable overlay=yes in $CMDLINE"
  sed -i -E 's/(rootwait) overlay=yes/\1/' "$CMDLINE" || true
else
  echo "   WARN: cmdline.txt not found under $BOOT — skip overlay revert (do it by hand)"
fi

# ── [1] restore LOG_LEVEL ──
if [[ -f "$CONFIG" ]]; then
  echo ">> [1] restore LOG_LEVEL=INFO"
  sed -i 's|^LOG_LEVEL=.*|LOG_LEVEL=INFO|' "$CONFIG" || true
fi

echo
echo "Done. Unmount both partitions cleanly, then boot the Pi:"
echo "  sudo umount $BOOT $ROOT   # (or the bind/upper mounts if any)"
