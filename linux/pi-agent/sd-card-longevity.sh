#!/usr/bin/env bash
#
# sd-card-longevity.sh — reduce SD-card writes for the Hearth-Connect Pi Agent.
#
# Your agent barely writes to disk on its own (only a few small config files,
# on events). The real SD wear comes from Raspberry Pi OS. On CURRENT Pi OS
# images (bookworm) several classic mitigations are ALREADY in place or are
# unnecessary, so this script no longer offers them:
#
#   • Swap is provided by zram (/dev/zram0) — compressed in RAM, writes nothing
#     to the card. The old disk-backed /var/swap swap file is gone, so there is
#     nothing to disable.
#   • /tmp and /run are already tmpfs (systemd default), so transient writes
#     already hit RAM.
#   • The root fs already mounts with noatime, so only /boot still needs that
#     flag.
#
# What remains are the mitigations still worth applying, ordered from LEAST to
# MOST intrusive, each with its trade-off printed below.
#
# Usage:
#   sudo bash sd-card-longevity.sh            # interactive menu
#   sudo bash sd-card-longevity.sh --info     # just show the trade-off table
#   sudo bash sd-card-longevity.sh --apply 2,3,4   # apply selected options
#   sudo bash sd-card-longevity.sh --dry-run  # show what would change, no writes
#
# Every change is idempotent and backed up before editing. A reboot is required
# for fstab / journald / overlay changes to take full effect.
#
set -e

DRY_RUN=0
APPLY_LIST=""
INFO_ONLY=0

for a in "$@"; do
  case "$a" in
    --dry-run)  DRY_RUN=1 ;;
    --info)     INFO_ONLY=1 ;;
    --apply)    : ;;  # value handled below
    --apply=*)  APPLY_LIST="${a#*=}" ;;
    *)          if [[ "$prev" == "--apply" ]]; then APPLY_LIST="$a"; fi ;;
  esac
  prev="$a"
done

FSTAB=/etc/fstab
JOURNALD=/etc/systemd/journald.conf
OVERLAY_CONF=/boot/firmware/cmdline.txt

# ─── Option table (ordered least → most intrusive) ──────────────────────────
# Each row: id | title | saves_most | +
print_table() {
  echo "SD-CARD WEAR REDUCTION OPTIONS  (1 = least intrusive … 5 = most)"
  echo
  printf "%-3s %-34s %-11s\n" "##" "OPTION" "IMPACT"
  echo "--------------------------------------------------------------------------"
  printf "%-3s %-34s %-11s\n" "1" "Lower agent log verbosity" "low"
  printf "%-3s %-34s %-11s\n" "2" "noatime/nodiratime on /boot" "HIGH"
  printf "%-3s %-34s %-11s\n" "3" "Journal to RAM (volatile)" "HIGH"
  printf "%-3s %-34s %-11s\n" "4" "tmpfs for /var/log" "HIGH"
  printf "%-3s %-34s %-11s\n" "5" "Read-only root (overlayfs)" "MAX"
  echo
  echo "TRADE-OFFS"
  echo "--------------------------------------------------------------------------"
  echo "1. Lower agent log verbosity"
  echo "     + Trivial; one env/line change. Reduces journal volume (see 3) so the"
  echo "       RAM journal stays small. Agent already writes little; smallest impact."
  echo "     - Only helps once the journal is in RAM (3) — without it, still churns"
  echo "       the disk journal, just less."
  echo
  echo "2. noatime/nodiratime on /boot  [SAVES MOST of what's left for normal use]"
  echo "     + Kills filesystem metadata writes on /boot (every file read normally"
  echo "       updates atime). The root fs already has noatime on current Pi OS, so"
  echo "       this is the only fstab mount flag still worth adding."
  echo "     - Requires reboot to take effect on the mounted /boot fs."
  echo
  echo "3. Journal to RAM (Storage=volatile)  [HIGH impact]"
  echo "     + The agent logs to stdout → journal; this keeps ALL of it off the"
  echo "       card. Big win since the agent logs at WARNING/INFO."
  echo "     - No logs survive a reboot — harder to debug post-crash."
  echo
  echo "4. tmpfs for /var/log  [HIGH impact]"
  echo "     + Catches every other daemon's logs, not just the agent's journal."
  echo "     - Lost on reboot; a few services expect persistent log dirs (they"
  echo "       recreate them in tmpfs on boot, usually fine)."
  echo
  echo "5. Read-only root (overlayfs)  [MAX — zero steady-state writes]"
  echo "     + Near-zero SD writes in steady state; best card longevity possible."
  echo "     - Most complex. apt/OS updates need a rw remount; you must carve out"
  echo "       /opt/hearth-pi-agent as a persistent rw bind or the agent loses its"
  echo "       device_id/server_url on every reboot. Reboot required."
  echo
}

# ─── helpers ────────────────────────────────────────────────────────────────
backup() {
  local f="$1"
  if [[ -f "$f" && ! -f "$f.hearth-bak" ]]; then
    if [[ $DRY_RUN -eq 1 ]]; then echo "  [dry-run] would back up $f → $f.hearth-bak"
    else cp -p "$f" "$f.hearth-bak"; echo "  backed up $f → $f.hearth-bak"; fi
  fi
}
run() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "  [dry-run] $*"; else eval "$*"; fi
}
need_root() { [[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }; }

# ─── option implementations ─────────────────────────────────────────────────
opt1_loglevel() {
  echo ">> [1] Lower agent log verbosity to WARNING"
  local cfg=/opt/hearth-pi-agent/config.env
  if [[ -f "$cfg" ]]; then
    backup "$cfg"
    if grep -q '^LOG_LEVEL=' "$cfg"; then
      run "sed -i 's|^LOG_LEVEL=.*|LOG_LEVEL=WARNING|' $cfg"
    else
      run "echo 'LOG_LEVEL=WARNING' >> $cfg"
    fi
  else
    echo "  (no config.env at $cfg — set LOG_LEVEL=WARNING in the agent env instead)"
  fi
  echo "  Restart the agent: sudo systemctl restart hearth-pi-agent"
}

opt2_boot_noatime() {
  echo ">> [2] Add noatime,nodiratime to /boot/firmware"
  echo "   (The root fs already mounts with noatime on current Pi OS images,"
  echo "    so only /boot still needs this flag.)"
  backup "$FSTAB"
  if grep -E '\s/boot' "$FSTAB" | grep -q 'noatime'; then
    echo "  /boot already has noatime — skipping"
  else
    run "sed -i -E 's#(.*\s/boot[a-z/]*\s+[a-z0-9]+\s+defaults)(.*)#\1,noatime,nodiratime\2#' $FSTAB"
  fi
  echo "  Reboot to apply to the mounted /boot fs."
}

opt3_journal_ram() {
  echo ">> [3] Journal to RAM (Storage=volatile)"
  backup "$JOURNALD"
  if grep -q '^Storage=' "$JOURNALD"; then
    run "sed -i 's/^Storage=.*/Storage=volatile/' $JOURNALD"
  else
    run "echo 'Storage=volatile' >> $JOURNALD"
  fi
  if grep -q '^RuntimeMaxUse=' "$JOURNALD"; then
    run "sed -i 's/^RuntimeMaxUse=.*/RuntimeMaxUse=16M/' $JOURNALD"
  else
    run "echo 'RuntimeMaxUse=16M' >> $JOURNALD"
  fi
  run "systemctl restart systemd-journald || true"
  echo "  Journal now lives in RAM; logs won't survive reboot."
}

opt4_varlog_tmpfs() {
  echo ">> [4] tmpfs for /var/log"
  backup "$FSTAB"
  if grep -q 'tmpfs /var/log ' "$FSTAB"; then
    echo "  already present — skipping"
  else
    run "echo 'tmpfs /var/log tmpfs defaults,noatime,mode=0755,size=64m 0 0' >> $FSTAB"
  fi
  echo "  Reboot to mount /var/log in RAM (services recreate subdirs on boot)."
}

opt5_readonly_root() {
  echo ">> [5] Read-only root via overlayfs (most intrusive)"
  if [[ ! -f "$OVERLAY_CONF" ]]; then
    echo "  ERROR: $OVERLAY_CONF not found (newer Pi OS uses /boot/firmware/cmdline.txt)."
    echo "  Adjust OVERLAY_CONF in this script for your image, then re-run."
    return 1
  fi
  backup "$OVERLAY_CONF"
  if grep -q 'overlay' "$OVERLAY_CONF"; then
    echo "  overlay already enabled — skipping"
  else
    run "sed -i -E 's/(rootwait)/\1 overlay=yes/' $OVERLAY_CONF"
  fi
  # Carve out a persistent rw bind for the agent's config + runtime state so
  # device_id / server_url survive reboots.
  backup "$FSTAB"
  if grep -q '# hearth-persist' "$FSTAB"; then
    echo "  persistent bind already present — skipping"
  else
    run "echo '# hearth-persist: keep agent config on real SD' >> $FSTAB"
    run "echo '/opt/hearth-pi-agent /opt/hearth-pi-agent none bind,rw 0 0' >> $FSTAB"
  fi
  echo "  Reboot. To update the OS later: 'sudo raspi-config' → disable overlay,"
  echo "  reboot rw, apt update, then re-enable overlay and reboot."
}

# ─── main ───────────────────────────────────────────────────────────────────
declare -A OPTS=( [1]=opt1_loglevel [2]=opt2_boot_noatime [3]=opt3_journal_ram
                   [4]=opt4_varlog_tmpfs [5]=opt5_readonly_root )

print_table

if [[ $INFO_ONLY -eq 1 ]]; then
  exit 0
fi

need_root

apply_one() {
  local id="$1"
  if [[ -z "${OPTS[$id]:-}" ]]; then echo "  unknown option: $id"; return; fi
  echo; "${OPTS[$id]}"
}

if [[ -n "$APPLY_LIST" ]]; then
  IFS=',' read -ra ids <<< "$APPLY_LIST"
  for id in "${ids[@]}"; do apply_one "$id"; done
else
  echo "Apply which options? (e.g. '2,3,4' or 'all'). Ordered 1..5 above."
  read -r -p "Selection: " sel
  if [[ "$sel" == "all" ]]; then sel="1,2,3,4,5"; fi
  IFS=',' read -ra ids <<< "$sel"
  for id in "${ids[@]}"; do apply_one "${id// /}"; done
fi

echo
echo "Done. Reboot to fully apply filesystem/journal/overlay changes:"
echo "  sudo reboot"
