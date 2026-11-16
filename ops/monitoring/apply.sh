#!/usr/bin/env bash
# Google Cloud Monitoring for venue-call-agent (venue-call plan it-08, TASK-3859).
#
#   bash ops/monitoring/apply.sh [dev|prod|all]          # DRY RUN (the default): prints every gcloud command
#   APPLY=1 bash ops/monitoring/apply.sh dev             # the real run, one environment
#   OFFLINE=1 bash ops/monitoring/apply.sh all           # dry run with no gcloud at all (no reads either)
#
# What it creates, per environment (parameters in ops/monitoring/env/<env>.env):
#   - three log-based counter metrics (templates/metric-*.json),
#   - an HTTPS uptime check on <service URL>/health,
#   - five alert policies (templates/policy-*.json): 5xx, crash loop, call ended badly,
#     speech cascade not warming, /health uptime,
#   - a Pub/Sub topic vca-budget-<env> and a monthly budget alert filtered on label env=<env>.
# Notifications go to the existing email channel for NOTIFY_EMAIL (default peter@creatorain.com);
# the channel is created only when it is missing AND this is a real run.
#
# Idempotent: every object is looked up first. Metrics and policies that exist are updated from the
# file; an uptime check, topic or channel that exists is left alone; a budget that exists gets its
# amount updated. Nothing here places a call, deploys, or changes the service: it only watches it.
#
# Reads (describe/list) run in a dry run too, so the plan says create or update; OFFLINE=1 skips them.
set -euo pipefail

# Git Bash on Windows rewrites arguments that start with "/" into Windows paths ("--path=/health"
# would become "C:/Program Files/Git/health"). Off for the whole script.
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${PROJECT:-creatorain-27e9e}"
REGION="${REGION:-us-central1}"
NOTIFY_EMAIL="${NOTIFY_EMAIL:-peter@creatorain.com}"
UPTIME_REGIONS="${UPTIME_REGIONS:-usa-iowa,usa-oregon,usa-virginia}"

APPLY="${APPLY:-0}"
if [ "$APPLY" = "1" ]; then DRY_RUN="${DRY_RUN:-0}"; else DRY_RUN=1; fi
OFFLINE="${OFFLINE:-0}"
if [ "$DRY_RUN" = "1" ]; then MODE="DRY RUN"; else MODE="APPLY"; fi

TARGET="${1:-all}"
case "$TARGET" in
  dev|prod) ENVS="$TARGET" ;;
  all) ENVS="dev prod" ;;
  *) echo "usage: [APPLY=1] bash ops/monitoring/apply.sh [dev|prod|all]" >&2; exit 64 ;;
esac

# --- gcloud ---------------------------------------------------------------------------------------
# With MSYS_NO_PATHCONV=1 the gcloud shell wrapper on Git Bash hands Python a POSIX path it cannot
# open, so on MINGW/MSYS gcloud.py is run directly with a Windows-form path.
GCLOUD=(gcloud)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v gcloud >/dev/null 2>&1; then
      sdk_root="$(cygpath -m "$(dirname "$(dirname "$(command -v gcloud)")")")"
      GCLOUD=("${CLOUDSDK_PYTHON:-python}" "$sdk_root/lib/gcloud.py")
    fi
    ;;
esac

gc() { "${GCLOUD[@]}" "$@"; }

# Print a command; run it only on a real run.
run() {
  printf '+ gcloud'; printf ' %q' "$@"; printf '\n'
  if [ "$DRY_RUN" != "1" ]; then gc "$@"; fi
}

# A read. Always quiet on error (a missing object is an answer). Empty in OFFLINE mode.
read_gc() {
  if [ "$OFFLINE" = "1" ]; then return 0; fi
  gc "$@" 2>/dev/null || true
}

# A list read. Empty means "none exist", so a FAILED list (a 429, no permission) must not read as
# empty: on a real run it stops the script rather than create a duplicate; on a dry run it warns.
# Usage: read_list VAR gcloud-args... ; sets VAR to the first line of stdout. Not run in a subshell,
# so the exit really stops the script.
read_list() {
  local __var="$1"; shift
  printf -v "$__var" '%s' ""
  if [ "$OFFLINE" = "1" ]; then return 0; fi
  local out err="$TMP/.list-err"
  if out="$(gc "$@" 2>"$err")"; then
    printf -v "$__var" '%s' "$(printf '%s\n' "$out" | head -n1)"
    return 0
  fi
  echo "!! list failed: gcloud $*" >&2
  tail -n 3 "$err" >&2
  if [ "$DRY_RUN" != "1" ]; then exit 1; fi
}

# Rendered files go to a temp dir, or to RENDER_DIR (kept, for review) when that is set.
if [ -n "${RENDER_DIR:-}" ]; then
  mkdir -p "$RENDER_DIR"; TMP="$(cd "$RENDER_DIR" && pwd)"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fi
# A Windows gcloud cannot open /tmp/...: hand it the C:/... form of the same directory.
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; fi

# render <template> <out> : replaces @PROJECT@ @ENV@ @SERVICE@ @CHANNEL@ @HOST@.
render() {
  sed -e "s|@PROJECT@|$PROJECT|g" -e "s|@ENV@|$ENV_NAME|g" -e "s|@SERVICE@|$SERVICE|g" \
      -e "s|@CHANNEL@|$CHANNEL|g" -e "s|@HOST@|${HOST:-HOST_UNKNOWN}|g" "$1" > "$2"
}

# The top-level displayName of a policy file (the only one at two-space indent).
display_name() { sed -n 's/^  "displayName": "\(.*\)",$/\1/p' "$1"; }

echo "== venue-call-agent monitoring: $MODE, project $PROJECT, environments: $ENVS"

# --- notification channel (shared by both environments) -------------------------------------------
read_list CHANNEL beta monitoring channels list --project="$PROJECT" \
  --filter="type=\"email\" AND labels.email_address=\"$NOTIFY_EMAIL\"" --format='value(name)'
if [ -n "$CHANNEL" ]; then
  echo "-- channel: exists $CHANNEL ($NOTIFY_EMAIL)"
else
  echo "-- channel: none for $NOTIFY_EMAIL, create"
  if [ "$DRY_RUN" = "1" ]; then
    run beta monitoring channels create --project="$PROJECT" --type=email \
      --display-name="Peter (email)" --channel-labels="email_address=$NOTIFY_EMAIL"
    CHANNEL="projects/$PROJECT/notificationChannels/NEW_CHANNEL_ID"
  else
    CHANNEL="$(run beta monitoring channels create --project="$PROJECT" --type=email \
      --display-name="Peter (email)" --channel-labels="email_address=$NOTIFY_EMAIL" \
      --format='value(name)' | tail -n1)"
    [ -n "$CHANNEL" ] || { echo "channel create returned no name" >&2; exit 1; }
  fi
fi

# --- billing account (for the budgets) -------------------------------------------------------------
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"
if [ -z "$BILLING_ACCOUNT" ]; then
  BILLING_ACCOUNT="$(read_gc billing projects describe "$PROJECT" --format='value(billingAccountName)')"
  BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"
fi
[ -n "$BILLING_ACCOUNT" ] || BILLING_ACCOUNT="BILLING_ACCOUNT_UNKNOWN"

for ENV_NAME in $ENVS; do
  SERVICE=""; BUDGET_USD=""; UPTIME_PERIOD_MIN=""; HOST=""
  # shellcheck source=/dev/null
  . "$HERE/env/$ENV_NAME.env"
  : "${SERVICE:?env/$ENV_NAME.env sets no SERVICE}" "${BUDGET_USD:?}" "${UPTIME_PERIOD_MIN:?}"
  OUT="$TMP/$ENV_NAME"; mkdir -p "$OUT"
  echo
  echo "== $ENV_NAME: service $SERVICE"

  # --- log-based metrics (before the policies that read them) ---
  for tpl in "$HERE"/templates/metric-*.json; do
    f="$OUT/$(basename "$tpl")"; render "$tpl" "$f"
    name="$(sed -n 's/^  "name": "\(.*\)",$/\1/p' "$f")"
    if [ -n "$(read_gc logging metrics describe "$name" --project="$PROJECT" --format='value(name)')" ]; then
      echo "-- metric $name: exists, update"
      run logging metrics update "$name" --project="$PROJECT" --config-from-file="$f"
    else
      echo "-- metric $name: create"
      run logging metrics create "$name" --project="$PROJECT" --config-from-file="$f"
    fi
  done

  # --- uptime check (needs the service URL) ---
  url="$(read_gc run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format='value(status.url)')"
  if [ -n "$url" ]; then
    HOST="${url#https://}"; HOST="${HOST%%/*}"
  elif [ "$OFFLINE" = "1" ]; then
    HOST="$SERVICE-HASH-uc.a.run.app"
    echo "-- OFFLINE: service URL not read; using placeholder host $HOST"
  fi
  if [ -z "$HOST" ]; then
    echo "-- uptime: service $SERVICE not found in $REGION; uptime check and its policy SKIPPED (rerun after the service exists)"
  else
    uptime_name="vca-$ENV_NAME /health"
    read_list existing monitoring uptime list-configs --project="$PROJECT" \
      --filter="displayName=\"$uptime_name\"" --format='value(name)'
    if [ -n "$existing" ]; then
      echo "-- uptime '$uptime_name': exists $existing, left alone"
    else
      echo "-- uptime '$uptime_name': create (https://$HOST/health every $UPTIME_PERIOD_MIN min)"
      run monitoring uptime create "$uptime_name" --project="$PROJECT" \
        --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT" \
        --protocol=https --port=443 --path=/health --request-method=get --validate-ssl=true \
        --status-classes=2xx --period="$UPTIME_PERIOD_MIN" --timeout=30 --regions="$UPTIME_REGIONS" \
        --user-labels="env=$ENV_NAME,service=venue-call-agent"
    fi
  fi

  # --- alert policies ---
  for tpl in "$HERE"/templates/policy-*.json; do
    if [ "$(basename "$tpl")" = "policy-uptime.json" ] && [ -z "$HOST" ]; then continue; fi
    f="$OUT/$(basename "$tpl")"; render "$tpl" "$f"
    dn="$(display_name "$f")"
    read_list existing monitoring policies list --project="$PROJECT" \
      --filter="displayName=\"$dn\"" --format='value(name)'
    if [ -n "$existing" ]; then
      echo "-- policy '$dn': exists $existing, update"
      run monitoring policies update "$existing" --project="$PROJECT" --policy-from-file="$f"
    else
      echo "-- policy '$dn': create"
      # A log-based metric created a moment ago can take a minute to be known to Monitoring.
      for try in 1 2 3 4; do
        if run monitoring policies create --project="$PROJECT" --policy-from-file="$f"; then break; fi
        [ "$try" = 4 ] && { echo "policy create failed: $dn" >&2; exit 1; }
        echo "   retry in 30s ($try/3)"; sleep 30
      done
    fi
  done

  # --- budget: Pub/Sub topic, then the budget ---
  topic="vca-budget-$ENV_NAME"
  if [ -n "$(read_gc pubsub topics describe "$topic" --project="$PROJECT" --format='value(name)')" ]; then
    echo "-- topic $topic: exists"
  else
    echo "-- topic $topic: create"
    run pubsub topics create "$topic" --project="$PROJECT" --labels="env=$ENV_NAME,service=venue-call-agent"
  fi
  budget_name="venue-call-agent $ENV_NAME (label env=$ENV_NAME)"
  read_list existing billing budgets list --billing-account="$BILLING_ACCOUNT" \
    --filter="displayName=\"$budget_name\"" --format='value(name)'
  if [ -n "$existing" ]; then
    echo "-- budget '$budget_name': exists $existing, set amount ${BUDGET_USD} USD"
    run billing budgets update "$existing" --budget-amount="${BUDGET_USD}USD"
  else
    echo "-- budget '$budget_name': create, ${BUDGET_USD} USD/month, alert only"
    run billing budgets create --billing-account="$BILLING_ACCOUNT" --display-name="$budget_name" \
      --budget-amount="${BUDGET_USD}USD" --calendar-period=month \
      --filter-projects="projects/$PROJECT" --filter-labels="env=$ENV_NAME" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 \
      --threshold-rule=percent=1.0,basis=forecasted-spend \
      --notifications-rule-pubsub-topic="projects/$PROJECT/topics/$topic" \
      --notifications-rule-monitoring-notification-channels="$CHANNEL"
  fi
done

echo
if [ "$DRY_RUN" = "1" ]; then echo "== DRY RUN: nothing was created or changed. Real run: APPLY=1 bash ops/monitoring/apply.sh $TARGET"; else echo "== APPLY done"; fi
