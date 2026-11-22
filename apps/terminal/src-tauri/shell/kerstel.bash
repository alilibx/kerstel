# Kerstel Terminal shell integration for bash (bash 3.2 on macOS and newer).
# Started as `bash --rcfile <this> -i`, so load the user's files like a login shell.
[ -r /etc/profile ] && . /etc/profile
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi

_ks_ran=0
_ks_at_prompt=0
_ks_precmd() {
  local code=$?
  [ "$_ks_ran" = 1 ] && printf '\e]133;D;%s\a' "$code"
  _ks_ran=0
  printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "${PWD//\%/%25}"
  printf '\e]133;A\a'
}
_ks_preexec() {
  [ "$_ks_at_prompt" = 1 ] || return
  [ "$BASH_COMMAND" = "_ks_precmd" ] && return
  _ks_at_prompt=0
  _ks_ran=1
  local line
  line=$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')
  printf '\e]6973;cmd;%s\a' "$(printf '%s' "$line" | base64 | tr -d '\n')"
  printf '\e]133;C\a'
}
# Arm the preexec hook only after every PROMPT_COMMAND part has run.
PROMPT_COMMAND="_ks_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND};_ks_at_prompt=1"
trap '_ks_preexec' DEBUG
