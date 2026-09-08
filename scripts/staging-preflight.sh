#!/usr/bin/env bash
# Staging preflight — prove the STAGING edge functions have their secrets wired
# before a QA run or a deploy. Read-only: every probe is a request that cannot
# mutate data (an unknown target, an invalid token, a 20-word classification).
#
# Usage (repo root; Windows users: run in Git Bash):
#   npm run preflight:staging            # loads ./.env.staging if present
#   bash scripts/staging-preflight.sh --print   # dry run: print the requests, send nothing
#   (--print still requires SUPABASE_URL to be the staging ref — the safety
#    abort runs before anything else, in every mode.)
#
# Needs from .env.staging (gitignored):
#   SUPABASE_URL                 https://jhipmqdpjenojfhfjgzq.supabase.co   (must be the staging ref)
#   SUPABASE_ANON_KEY            staging anon key (apikey header)
#   SUPABASE_SERVICE_ROLE_KEY    staging service-role key — used ONLY as the Bearer
#                                for ai_task / cron-dispatcher, which accept it as a caller.
#
# Checks (each exits non-zero naming the missing secret):
#   LOVABLE_API_KEY          ai_task {task:"intent_router"}  -> 200 (500 "AI gateway not configured" = missing)
#   INTERNAL_API_SECRET      cron-dispatcher unknown target  -> 400 (500 "Not configured" = missing; 401 = bad Bearer)
#   UNSUBSCRIBE_TOKEN_SECRET outreach-unsubscribe bad token  -> 400 (anything else = broken; a blank secret
#                            fails closed as 400 too — see the secrets-list check below for the name itself)
#   OPENAI_API_KEY           no edge function exposes it read-only (generate-embedding never reads it;
#                            process-knowledge-document would write chunks). Checked by NAME via
#                            `supabase secrets list --project-ref <staging>` when the CLI is available,
#                            otherwise reported as UNVERIFIED (not a failure).
set -u

STAGING_REF="jhipmqdpjenojfhfjgzq"
PRINT_ONLY=0
for a in "$@"; do
  case "$a" in
    --print) PRINT_ONLY=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $a (only --print is supported)"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.." || exit 1

if [ -f .env.staging ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.staging
  set +a
fi

URL="${SUPABASE_URL:-}"
URL="${URL%/}"
case "$URL" in
  *"$STAGING_REF"*) ;;
  *)
    echo "SAFETY ABORT: SUPABASE_URL ('$URL') does not contain the staging ref $STAGING_REF." >&2
    echo "This preflight only ever runs against staging. Load .env.staging first:  set -a; . ./.env.staging; set +a" >&2
    exit 1 ;;
esac

ANON="${SUPABASE_ANON_KEY:-}"
SERVICE="${SUPABASE_SERVICE_ROLE_KEY:-}"
if [ "$PRINT_ONLY" -eq 0 ] && { [ -z "$ANON" ] || [ -z "$SERVICE" ]; }; then
  echo "Missing SUPABASE_ANON_KEY and/or SUPABASE_SERVICE_ROLE_KEY (staging values, from .env.staging)." >&2
  exit 1
fi
[ "$PRINT_ONLY" -eq 1 ] && { ANON="${ANON:-<SUPABASE_ANON_KEY>}"; SERVICE="${SERVICE:-<SUPABASE_SERVICE_ROLE_KEY>}"; }

FAILURES=0
UNVERIFIED=""

# probe <label> <method> <path> <bearer> <json-body-or-empty>
# Sets STATUS and BODY. In --print mode only echoes the request.
probe() {
  local label="$1" method="$2" path="$3" bearer="$4" data="$5"
  local target="$URL/functions/v1/$path"
  echo "== $label"
  if [ "$PRINT_ONLY" -eq 1 ]; then
    printf '   curl -sS -X %s "%s" -H "apikey: <anon>"' "$method" "$target"
    [ -n "$bearer" ] && printf ' -H "Authorization: Bearer <%s>"' "$bearer"
    [ -n "$data" ] && printf -- ' -H "Content-Type: application/json" -d '"'"'%s'"'"'' "$data"
    printf '\n'
    STATUS="000"; BODY=""
    return 0
  fi
  local tmp; tmp="$(mktemp)"
  local auth_header=()
  [ -n "$bearer" ] && auth_header=(-H "Authorization: Bearer $bearer")
  if [ -n "$data" ]; then
    STATUS="$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$target" \
      -H "apikey: $ANON" ${auth_header[@]+"${auth_header[@]}"} -H "Content-Type: application/json" -d "$data")" || STATUS="000"
  else
    STATUS="$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$target" \
      -H "apikey: $ANON" ${auth_header[@]+"${auth_header[@]}"})" || STATUS="000"
  fi
  BODY="$(head -c 300 "$tmp" | tr '\n' ' ')"
  rm -f "$tmp"
  echo "   -> HTTP $STATUS  $BODY"
}

fail() { echo "   FAIL: $1" >&2; FAILURES=$((FAILURES + 1)); }
ok()   { echo "   ok: $1"; }

# ── 1. LOVABLE_API_KEY via ai_task intent_router (read-only classification) ──
# Request shape from classify-inbound -> ai_task: {task, payload:{lead_context, email_text}}.
# Service-role Bearer is accepted by ai_task (isServiceRole path); no lead_id, so nothing is looked up.
INTENT_BODY='{"task":"intent_router","payload":{"lead_context":"","email_text":"Hi, thanks for the demo yesterday. Could you send pricing for fifty seats and confirm the pilot terms still apply?"}}'
if [ "$PRINT_ONLY" -eq 1 ]; then
  probe "LOVABLE_API_KEY (ai_task intent_router)" POST "ai_task" "SUPABASE_SERVICE_ROLE_KEY" "$INTENT_BODY"
else
  probe "LOVABLE_API_KEY (ai_task intent_router)" POST "ai_task" "$SERVICE" "$INTENT_BODY"
  case "$STATUS" in
    200) ok "LOVABLE_API_KEY is set (intent_router returned 200)" ;;
    500) fail "LOVABLE_API_KEY is MISSING on staging (ai_task returned 500 'AI gateway not configured')" ;;
    401) fail "SUPABASE_SERVICE_ROLE_KEY is not staging's service key (ai_task 401) — cannot assess LOVABLE_API_KEY" ;;
    *)   fail "ai_task returned HTTP $STATUS — inspect function logs (LOVABLE_API_KEY undetermined)" ;;
  esac
fi

# ── 2. INTERNAL_API_SECRET via cron-dispatcher (unknown target is rejected BEFORE any forward) ──
DISPATCH_BODY='{"target":"preflight-unknown-target"}'
if [ "$PRINT_ONLY" -eq 1 ]; then
  probe "INTERNAL_API_SECRET (cron-dispatcher unknown target)" POST "cron-dispatcher" "SUPABASE_SERVICE_ROLE_KEY" "$DISPATCH_BODY"
else
  probe "INTERNAL_API_SECRET (cron-dispatcher unknown target)" POST "cron-dispatcher" "$SERVICE" "$DISPATCH_BODY"
  case "$STATUS" in
    400) ok "INTERNAL_API_SECRET is set (dispatcher reached target validation: 400)" ;;
    500) fail "INTERNAL_API_SECRET is MISSING on staging (cron-dispatcher returned 500 'Not configured')" ;;
    401) fail "cron-dispatcher rejected the caller (401) — SUPABASE_SERVICE_ROLE_KEY is not staging's service key" ;;
    *)   fail "cron-dispatcher returned HTTP $STATUS (expected 400)" ;;
  esac
fi

# ── 3. UNSUBSCRIBE_TOKEN_SECRET via outreach-unsubscribe with a forged token (GET never mutates) ──
if [ "$PRINT_ONLY" -eq 1 ]; then
  probe "UNSUBSCRIBE_TOKEN_SECRET (outreach-unsubscribe bad token)" GET "outreach-unsubscribe?token=preflight.invalid" "" ""
else
  probe "UNSUBSCRIBE_TOKEN_SECRET (outreach-unsubscribe bad token)" GET "outreach-unsubscribe?token=preflight.invalid" "" ""
  case "$STATUS" in
    400) ok "outreach-unsubscribe rejects a forged token with 400 (verify path healthy)" ;;
    500) fail "outreach-unsubscribe returned 500 — UNSUBSCRIBE_TOKEN_SECRET handling is broken on staging" ;;
    *)   fail "outreach-unsubscribe returned HTTP $STATUS (expected 400)" ;;
  esac
fi

# ── 4. Secret NAMES via the CLI (covers OPENAI_API_KEY, which has no read-only HTTP path) ──
echo "== secret names (supabase secrets list --project-ref $STAGING_REF)"
if [ "$PRINT_ONLY" -eq 1 ]; then
  echo "   supabase secrets list --project-ref $STAGING_REF   # then grep for LOVABLE_API_KEY OPENAI_API_KEY INTERNAL_API_SECRET UNSUBSCRIBE_TOKEN_SECRET"
elif command -v supabase >/dev/null 2>&1; then
  LIST="$(supabase secrets list --project-ref "$STAGING_REF" 2>/dev/null)" || LIST=""
  if [ -z "$LIST" ]; then
    UNVERIFIED="$UNVERIFIED OPENAI_API_KEY(cli-not-logged-in)"
    echo "   supabase CLI present but 'secrets list' failed (not logged in?) — OPENAI_API_KEY UNVERIFIED"
  else
    for name in LOVABLE_API_KEY OPENAI_API_KEY INTERNAL_API_SECRET UNSUBSCRIBE_TOKEN_SECRET; do
      if printf '%s\n' "$LIST" | grep -q "^[[:space:]]*$name[[:space:]|]"; then
        ok "$name present in staging secrets"
      else
        fail "$name is NOT set in staging secrets (supabase secrets list)"
      fi
    done
  fi
else
  UNVERIFIED="$UNVERIFIED OPENAI_API_KEY(no-supabase-cli)"
  echo "   supabase CLI not found — OPENAI_API_KEY UNVERIFIED (semantic KB search silently falls back to text search without it)"
fi

echo
if [ "$PRINT_ONLY" -eq 1 ]; then
  echo "Dry run only — nothing was sent."
  exit 0
fi
[ -n "$UNVERIFIED" ] && echo "UNVERIFIED:$UNVERIFIED"
if [ "$FAILURES" -gt 0 ]; then
  echo "PREFLIGHT FAILED: $FAILURES check(s) failed — see FAIL lines above." >&2
  exit 1
fi
echo "PREFLIGHT OK: staging ($STAGING_REF) secrets verified."
