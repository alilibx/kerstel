# Kerstel Terminal shell integration for zsh.
# Marks where each prompt and command starts and ends, so the terminal can show
# a quiet divider, the exit status and the duration of every command.
[[ -o interactive ]] || return 0
[[ -n "$KERSTEL_TERMINAL_LOADED" ]] && return 0
typeset -g KERSTEL_TERMINAL_LOADED=1
typeset -g _ks_ran=0

_ks_precmd() {
  local code=$?
  (( _ks_ran )) && printf '\e]133;D;%s\a' "$code"
  _ks_ran=0
  printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"
  printf '\e]133;A\a'
}
_ks_preexec() {
  _ks_ran=1
  printf '\e]6973;cmd;%s\a' "$(printf '%s' "$1" | base64 | tr -d '\n')"
  printf '\e]133;C\a'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _ks_precmd
add-zsh-hook preexec _ks_preexec
