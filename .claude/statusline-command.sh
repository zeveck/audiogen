#!/usr/bin/env bash
# Claude Code status line: context, 5-hour, and 7-day bars

input=$(cat)

# ANSI colors
MAGENTA='\033[35m'
CYAN='\033[36m'
TURQUOISE='\033[38;5;80m'
RESET='\033[0m'
DIM='\033[2m'

# Build a filled bar from a percentage
# Usage: make_bar <pct> <width> <color>
make_bar() {
  local pct="$1"
  local width="$2"
  local color="$3"
  local filled=$(( pct * width / 100 ))
  [ "$filled" -gt "$width" ] && filled=$width
  local empty=$(( width - filled ))
  local bar=""
  local i
  for (( i=0; i<filled; i++ )); do bar="${bar}█"; done
  for (( i=0; i<empty; i++ )); do bar="${bar}░"; done
  printf "${color}%s${RESET}" "$bar"
}

output=""

# Context window bar (magenta)
ctx=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$ctx" ]; then
  ctx_int=$(printf '%.0f' "$ctx")
  bar=$(make_bar "$ctx_int" 10 "$MAGENTA")
  output="${output}$(printf "${DIM}ctx${RESET} ")${bar}$(printf " ${MAGENTA}%3d%%${RESET}" "$ctx_int")"
fi

# 5-hour rate limit bar (turquoise)
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
if [ -n "$five" ]; then
  five_int=$(printf '%.0f' "$five")
  bar=$(make_bar "$five_int" 10 "$TURQUOISE")
  [ -n "$output" ] && output="${output}  "
  output="${output}$(printf "${DIM}5h${RESET} ")${bar}$(printf " ${TURQUOISE}%3d%%${RESET}" "$five_int")"
fi

# 7-day rate limit bar (cyan)
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
if [ -n "$week" ]; then
  week_int=$(printf '%.0f' "$week")
  bar=$(make_bar "$week_int" 10 "$CYAN")
  [ -n "$output" ] && output="${output}  "
  output="${output}$(printf "${DIM}7d${RESET} ")${bar}$(printf " ${CYAN}%3d%%${RESET}" "$week_int")"
fi

[ -n "$output" ] && printf "%b" "$output"
