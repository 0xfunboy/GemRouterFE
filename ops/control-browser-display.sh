#!/usr/bin/env bash
# Temporary operator access to ONE dedicated Chrome window. No installation,
# desktop/session manager, production service, public listener, CDP endpoint,
# screenshots, tracing or recording. Run as the controller user, never root.
#
#  start   -> private Xvfb display; launch BrowserUiBridge with printed env
#  viewer  -> after bridge opens Chrome, attach noVNC to its single X window
#  status  -> nonsecret observed state only
#  stop    -> stop only the recorded viewer/display processes; keep profiles
#  start/viewer --foreground -> retain a supervised terminal/tool session;
#                              closing it stops only its recorded children
#
# Sources: X.Org Xvfb(1), Playwright CI headed instructions,
# https://github.com/LibVNC/x11vnc/blob/master/doc/OPTIONS.md
# https://github.com/novnc/websockify
set -euo pipefail
umask 077

action=${1:-status}
foreground=${2:-}
if [[ $# -gt 2 || ! "$action" =~ ^(start|viewer|status|stop)$ || ( -n "$foreground" && ( "$foreground" != --foreground || ! "$action" =~ ^(start|viewer)$ ) ) ]]; then
  printf '%s\n' 'Usage: bash ops/control-browser-display.sh start|viewer [--foreground] | status | stop' >&2
  exit 2
fi
if [[ $(id -u) == 0 ]]; then printf '%s\n' 'Run as the dedicated controller user, not root.' >&2; exit 2; fi
operator_home=$(getent passwd "$(id -u)" | cut -d: -f6)
private_dir=${GEMROUTER_CHATGPT_CONTROL_PRIVATE_DIR:-"$operator_home/.local/share/gemrouter-personal-control"}
repository_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ "$private_dir" == "$(realpath -m -- "$private_dir")" ]] || { printf '%s\n' 'Use a canonical, nonsymlinked private storage path.' >&2; exit 2; }
if [[ "$private_dir" != /* || "$private_dir" == / || "$private_dir" == "$operator_home" || "$private_dir" == /home || "$private_dir" == /tmp || "$private_dir" == "$repository_dir" || "$private_dir" == "$repository_dir/"* || "$private_dir" == "$operator_home/.codex" || "$private_dir" == "$operator_home/.codex/"* ]]; then
  printf '%s\n' 'Private display state must be outside repository/backup and personal Codex profiles.' >&2; exit 2
fi
private_dir=$(realpath -m -- "$private_dir")
state_dir="$private_dir/display"
xauthority="$state_dir/Xauthority"
password_file="$state_dir/viewer-password"
display_number=${GEMROUTER_CONTROL_DISPLAY_NUMBER:-95}
viewer_port=${GEMROUTER_CONTROL_VIEWER_PORT:-8795}
vnc_port=${GEMROUTER_CONTROL_VNC_PORT:-5975}
if [[ ! "$display_number" =~ ^[1-9][0-9]{1,3}$ || ! "$viewer_port" =~ ^[1-9][0-9]{3,4}$ || ! "$vnc_port" =~ ^[1-9][0-9]{3,4}$ ]] || (( viewer_port > 65535 || vnc_port > 65535 || viewer_port == vnc_port )); then
  printf '%s\n' 'Invalid isolated display/loopback ports.' >&2; exit 2
fi
display=":$display_number"

fail() { printf '%s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null || fail "Missing prerequisite: $1 (this script never installs packages)."; }
private_file() {
  [[ -f "$1" && ! -L "$1" && $(stat -c %u -- "$1") == "$(id -u)" && $(stat -c %a -- "$1") == 600 ]]
}
tracked() {
  local name=$1 pid start executable current_start current_executable
  private_file "$state_dir/$name.pid" || return 1
  read -r pid start executable < "$state_dir/$name.pid"
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$start" =~ ^[0-9]+$ && -e "/proc/$pid/stat" ]] || return 1
  [[ $(stat -c %u "/proc/$pid") == "$(id -u)" ]] || return 1
  current_start=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null) || return 1
  current_executable=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || return 1
  [[ "$start" == "$current_start" && "$executable" == "$current_executable" ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
}
record() {
  local name=$1 pid=$2 executable start
  executable=$(readlink -f "/proc/$pid/exe") || fail 'Process exited before startup confirmation.'
  start=$(awk '{print $22}' "/proc/$pid/stat")
  printf '%s %s %s\n' "$pid" "$start" "$executable" > "$state_dir/$name.pid"
}
stop_tracked() {
  local name=$1 pid start executable
  if tracked "$name"; then
    read -r pid start executable < "$state_dir/$name.pid"
    kill -TERM "$pid"
    for _ in {1..30}; do tracked "$name" || break; sleep 0.1; done
    # Recheck PID creation time and executable again before any forced stop.
    if tracked "$name"; then kill -KILL "$pid"; fi
  fi
  if [[ -f "$state_dir/$name.pid" && ! -L "$state_dir/$name.pid" ]]; then rm -- "$state_dir/$name.pid"; fi
}
hold_children() {
  # nohup alone does not survive process-tree cleanup by an execution host.
  # Keep this foreground job alive, but release the operation lock so status,
  # viewer and explicit stop remain usable from another terminal.
  [[ "$foreground" == --foreground ]] || return 0
  local names=("$@") name pid start executable index
  local pids=()
  for name in "${names[@]}"; do
    tracked "$name" || fail 'A session process stopped before supervision.'
    read -r pid start executable < "$state_dir/$name.pid"
    pids+=("$pid")
  done
  exec 9>&-
  # A caught signal interrupts wait; cleanup below stays within this function's
  # local scope and never terminates a replacement launched by another caller.
  trap ':' INT TERM HUP
  printf '%s\n' 'SUPERVISION=foreground; keep this terminal/session open.'
  wait -n "${pids[@]}" || true
  trap - INT TERM HUP
  for index in "${!names[@]}"; do
    name=${names[$index]}
    if private_file "$state_dir/$name.pid"; then
      read -r pid start executable < "$state_dir/$name.pid"
      if [[ "$pid" == "${pids[$index]}" ]]; then stop_tracked "$name"; fi
    fi
  done
}
port_free() { [[ -z $(ss -H -ltn "sport = :$1") ]]; }
loopback_listening() {
  local entries
  entries=$(ss -H -ltn "sport = :$1" | awk '{print $4}')
  [[ "$entries" == "127.0.0.1:$1" ]]
}
read_metadata() {
  if private_file "$state_dir/config"; then
    read -r display_number viewer_port vnc_port < "$state_dir/config"
    [[ "$display_number" =~ ^[1-9][0-9]{1,3}$ && "$viewer_port" =~ ^[1-9][0-9]{3,4}$ && "$vnc_port" =~ ^[1-9][0-9]{3,4}$ ]] || fail 'Invalid display state metadata.'
    display=":$display_number"
  fi
}
status() {
  if [[ ! -d "$state_dir" || -L "$state_dir" ]]; then printf '%s\n' 'DISPLAY_STATE=not_started'; return; fi
  read_metadata
  if tracked xvfb; then
    printf 'DISPLAY_STATE=running\nDISPLAY=%s\nXAUTHORITY=%s\n' "$display" "$xauthority"
  else printf '%s\n' 'DISPLAY_STATE=not_running'; fi
  if tracked x11vnc && tracked websockify && loopback_listening "$viewer_port" && loopback_listening "$vnc_port"; then
    printf 'VIEWER_STATE=running\nVIEWER_URL=http://127.0.0.1:%s/vnc.html?autoconnect=false&resize=scale\nVIEWER_PASSWORD_FILE=%s\n' "$viewer_port" "$password_file"
    printf '%s\n' 'ACCESS=Forward only the viewer loopback port in the existing VS Code SSH connection. Keep visibility Private.'
  else printf '%s\n' 'VIEWER_STATE=not_running'; fi
}

if [[ "$action" == status ]]; then status; exit; fi
if [[ "$action" == stop && ! -d "$state_dir" ]]; then status; exit; fi
mkdir -p -m 700 -- "$private_dir" "$state_dir"
[[ ! -L "$private_dir" && ! -L "$state_dir" && $(realpath -- "$state_dir") == "$state_dir" ]] || fail 'Symlinked private display storage is forbidden.'
[[ $(stat -c %u -- "$private_dir") == "$(id -u)" && $(stat -c %u -- "$state_dir") == "$(id -u)" ]] || fail 'Private display storage belongs to another user.'
chmod 700 -- "$private_dir" "$state_dir"
need flock
exec 9>"$state_dir/launcher.lock"
flock -n 9 || fail 'Another isolated display operation is running.'
read_metadata

if [[ "$action" == stop ]]; then
  stop_tracked websockify
  stop_tracked x11vnc
  stop_tracked xvfb
  # Only disposable session credentials are removed. Never delete browser/Codex
  # profiles, the private directory, logs or any application/production state.
  for credential in "$xauthority" "$password_file" "$state_dir/state.json"; do
    if [[ -f "$credential" && ! -L "$credential" ]]; then rm -- "$credential"; fi
  done
  printf '%s\n' 'STOPPED: tracked display/viewer processes and ephemeral credentials; browser/Codex profiles retained. Closing the display also closes its browser windows; it does not revoke an account or MCP grant.'
  exit
fi

if [[ "$action" == start ]]; then
  if tracked xvfb; then status; exit; fi
  for binary in Xvfb xauth xdpyinfo openssl node; do need "$binary"; done
  [[ ! -e "/tmp/.X${display_number}-lock" && ! -S "/tmp/.X11-unix/X${display_number}" ]] || fail 'Chosen display is already owned. Do not reuse another display.'
  [[ ! -L "$xauthority" ]] || fail 'Invalid Xauthority path.'
  : > "$xauthority"
  # Cookie travels only through stdin to xauth, never argv, terminal or logs.
  display_cookie=$(openssl rand -hex 16)
  printf 'add %s . %s\n' "$display" "$display_cookie" | xauth -f "$xauthority" source - >/dev/null 2>&1
  unset display_cookie
  printf '%s %s %s\n' "$display_number" "$viewer_port" "$vnc_port" > "$state_dir/config"
  nohup Xvfb "$display" -screen 0 1440x1000x24 -nolisten tcp -auth "$xauthority" > "$state_dir/xvfb.log" 2>&1 < /dev/null 9>&- &
  xvfb_pid=$!
  ready=false
  for _ in {1..50}; do
    if DISPLAY="$display" XAUTHORITY="$xauthority" xdpyinfo >/dev/null 2>&1; then ready=true; break; fi
    kill -0 "$xvfb_pid" 2>/dev/null || break
    sleep 0.1
  done
  if [[ "$ready" != true ]]; then kill -TERM "$xvfb_pid" 2>/dev/null || true; fail 'Private Xvfb startup failed; see the private xvfb.log.'; fi
  record xvfb "$xvfb_pid"
  # Nonsecret metadata consumed by the real temporary onboarding process.
  node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1],JSON.stringify({display:process.argv[2],xauthority:process.argv[3]})+"\n",{mode:0o600});' "$state_dir/state.json" "$display" "$xauthority"
  status
  printf '%s\n' 'NEXT=Launch the existing BrowserUiBridge in this display; then run this script with viewer.'
  hold_children xvfb
  exit
fi

# A viewer may attach only after the real bridge has opened its headed browser.
tracked xvfb || fail 'Start the dedicated display first.'
for binary in x11vnc websockify xwininfo xprop openssl ss; do need "$binary"; done
[[ -f /usr/share/novnc/vnc.html ]] || fail 'Missing packaged noVNC web assets: /usr/share/novnc/vnc.html'
if tracked x11vnc && tracked websockify; then status; exit; fi
if tracked x11vnc || tracked websockify; then fail 'Partial viewer session exists; stop it explicitly before retrying.'; fi
port_free "$viewer_port" && port_free "$vnc_port" || fail 'Chosen loopback ports are already in use.'
# Chrome also creates an unmapped helper with its WM_CLASS. Only mapped normal
# windows can be the operator's browser. Never print window titles/history.
mapfile -t chrome_ids < <(DISPLAY="$display" XAUTHORITY="$xauthority" xwininfo -root -tree 2>/dev/null | awk '/\("[^"]*" "(Google-chrome|google-chrome|Chromium|chromium)"\)/ {print $1}')
window_ids=()
for candidate in "${chrome_ids[@]}"; do
  [[ "$candidate" =~ ^0x[0-9a-fA-F]+$ ]] || continue
  if DISPLAY="$display" XAUTHORITY="$xauthority" xwininfo -id "$candidate" 2>/dev/null | awk '/Map State:/ {found=($3 == "IsViewable")} END {exit !found}' \
    && DISPLAY="$display" XAUTHORITY="$xauthority" xprop -id "$candidate" _NET_WM_WINDOW_TYPE 2>/dev/null | awk '$0 == "_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL" {found=1} END {exit !found}'; then
    window_ids+=("$candidate")
  fi
done
[[ ${#window_ids[@]} == 1 && "${window_ids[0]}" =~ ^0x[0-9a-fA-F]+$ ]] || fail 'Exactly one dedicated Chrome window is required; viewer was not started.'
[[ ! -L "$password_file" ]] || fail 'Invalid viewer credential path.'
# Classic RFB authenticates the first eight characters. Strong transport is the
# existing SSH/VS Code forwarding; the random password also gates local access.
openssl rand -base64 6 > "$password_file"
nohup x11vnc -norc -display "$display" -auth "$xauthority" -id "${window_ids[0]}" -localhost -listen 127.0.0.1 -no6 \
  -rfbport "$vnc_port" -passwdfile "$password_file" -forever -noshared -nosel -input KMB -noremote -timeout 900 \
  > /dev/null 2>&1 < /dev/null 9>&- &
vnc_pid=$!
ready=false
for _ in {1..50}; do
  if loopback_listening "$vnc_port"; then ready=true; break; fi
  kill -0 "$vnc_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$ready" != true ]]; then kill -TERM "$vnc_pid" 2>/dev/null || true; fail 'Window-only VNC startup failed.'; fi
record x11vnc "$vnc_pid"
nohup websockify --web=/usr/share/novnc --idle-timeout=900 "127.0.0.1:$viewer_port" "127.0.0.1:$vnc_port" \
  > /dev/null 2>&1 < /dev/null 9>&- &
web_pid=$!
ready=false
for _ in {1..50}; do
  if loopback_listening "$viewer_port"; then ready=true; break; fi
  kill -0 "$web_pid" 2>/dev/null || break
  sleep 0.1
done
if [[ "$ready" != true ]]; then kill -TERM "$web_pid" 2>/dev/null || true; stop_tracked x11vnc; fail 'Loopback noVNC startup failed.'; fi
record websockify "$web_pid"
status
hold_children websockify x11vnc
