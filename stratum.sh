#!/bin/bash
# stratum.sh -- Stratum v7.4
# Command line interface for Stratum Flow Scout
# Usage: bash stratum.sh [command] [args]

RAILWAY_URL="https://flow-scout-production.up.railway.app"
SECRET="stratum2026"
COMMAND=$1

echo ""
echo "Stratum v7.4 -- $(date '+%Y-%m-%d %H:%M:%S ET')"
echo "================================"

# ================================================================
# HELP
# ================================================================
if [ -z "$COMMAND" ] || [ "$COMMAND" = "help" ]; then
  echo "Available commands:"
  echo ""
  echo "  STATUS & MONITORING"
  echo "  status          -- full system status"
  echo "  bias            -- current dynamic bias (BULLISH/BEARISH)"
  echo "  watchlist       -- John's ideas armed and watching"
  echo "  positions       -- open positions on live account"
  echo "  loss-limit      -- check if daily loss limit is triggered"
  echo "  winrate         -- SIM win rate tracker"
  echo ""
  echo "  TRADING"
  echo "  execute TICKER CONTRACT direction QTY LIMIT STOP T1   -- place order in SIM"
  echo "  execute TICKER CONTRACT direction QTY LIMIT STOP T1 live -- place on LIVE"
  echo "  close CONTRACT QTY [live]  -- close a position"
  echo "  eod             -- manually trigger EOD close all"
  echo ""
  echo "  JOHN'S IDEAS"
  echo "  idea TICKER direction TRIGGER LIMIT STOP T1 T2 [live] -- submit idea"
  echo "  watchlist       -- see all armed ideas"
  echo ""
  echo "  SYSTEM"
  echo "  sim on          -- enable SIM mode"
  echo "  sim off         -- disable SIM mode (live trading)"
  echo "  sim status      -- check current mode"
  echo "  morning         -- trigger morning brief manually"
  echo "  journal         -- trigger EOD journal manually"
  echo "  override        -- override daily loss limit (emergency only)"
  echo ""
  echo "  AGENT"
  echo "  agent           -- agent state"
  echo "  macro           -- current macro filter state"
  echo "  hold TICKER DATE -- set hold lock on ticker"
  echo ""
  exit 0
fi

# ================================================================
# STATUS -- full system check
# ================================================================
if [ "$COMMAND" = "status" ]; then
  echo "Checking system status..."
  echo ""
  curl -s "$RAILWAY_URL/agent/state" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('Agent:       ' + str(d.get('status','unknown')))
  print('6HR Bias:    ' + str(d.get('bias','unknown')))
  print('Buying Power: $' + str(d.get('buyingPower','unknown')))
  print('Positions:   ' + str(d.get('openPositions','unknown')))
  print('SIM Mode:    ' + str(d.get('simMode','unknown')))
except: print('Could not parse response')
"
  echo ""
  # Check loss limit
  curl -s "$RAILWAY_URL/loss-limit/status" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  live=d.get('live',{})
  print('Loss Limit (Live): ' + ('BLOCKED' if live.get('blocked') else 'OK'))
except: pass
"
  echo ""
fi

# ================================================================
# BIAS -- current dynamic bias
# ================================================================
if [ "$COMMAND" = "bias" ]; then
  echo "Checking dynamic bias..."
  curl -s "$RAILWAY_URL/bias" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  b=d.get('bias',{})
  print('Bias:     ' + str(b.get('bias','unknown')))
  print('Strength: ' + str(b.get('strength','unknown')))
  print('SPY:      \$' + str(b.get('spyPrice','unknown')))
  print('VWAP:     \$' + str(b.get('spyVwap','unknown')))
  print('Bar Type: ' + str(b.get('barType','unknown')))
  print('Updated:  ' + str(b.get('updatedAt','unknown')))
except: print('Could not parse bias')
"
  echo ""
fi

# ================================================================
# WATCHLIST -- John's ideas
# ================================================================
if [ "$COMMAND" = "watchlist" ]; then
  echo "John's idea watchlist..."
  curl -s "$RAILWAY_URL/idea/watchlist" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  w=d.get('watchlist',d)
  if not w:
    print('Watchlist is empty')
  else:
    for k,v in w.items():
      print(v.get('ticker','?') + ' ' + v.get('direction','?') + ' -- trigger: \$' + str(v.get('triggerPrice','?')) + ' -- ' + str(v.get('triggerType','?')))
except: print('Could not parse watchlist')
"
  echo ""
fi

# ================================================================
# LOSS LIMIT
# ================================================================
if [ "$COMMAND" = "loss-limit" ]; then
  curl -s "$RAILWAY_URL/loss-limit/status" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('Live account: ' + ('BLOCKED -- no new trades' if d.get('live',{}).get('blocked') else 'OK -- trading allowed'))
  print('SIM account:  ' + ('BLOCKED' if d.get('sim',{}).get('blocked') else 'OK'))
except: print('Could not check loss limit')
"
  echo ""
fi

# ================================================================
# EXECUTE -- place order
# SIM:  bash stratum.sh execute GOOGL "GOOGL 260410C300" call 1 4.06 2.79 7.44
# LIVE: bash stratum.sh execute GOOGL "GOOGL 260410C300" call 1 4.06 2.79 7.44 live
# ================================================================
if [ "$COMMAND" = "execute" ]; then
  TICKER=${2:-SPY}
  CONTRACT=${3:-SPY}
  TYPE=${4:-call}
  QTY=${5:-1}
  LIMIT=${6:-0}
  STOP=${7:-0}
  T1=${8:-0}
  LIVE=${9:-sim}
  ACTION="BUYTOOPEN"
  ACCOUNT="SIM3142118M"
  if [ "$LIVE" = "live" ]; then
    ACCOUNT="11975462"
  fi
  echo "Placing order: $CONTRACT x$QTY @ \$$LIMIT (stop=\$$STOP T1=\$$T1) on $ACCOUNT..."
  curl -s -X POST "$RAILWAY_URL/webhook/execute" \
    -H "Content-Type: application/json" \
    -H "x-stratum-secret: $SECRET" \
    -d "{\"account\":\"$ACCOUNT\",\"symbol\":\"$CONTRACT\",\"action\":\"$ACTION\",\"qty\":$QTY,\"limit\":$LIMIT,\"stop\":$STOP,\"t1\":$T1}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('status') == 'OK':
  r=d.get('result',{})
  print('ORDER PLACED OK')
  print('Order ID: ' + str(r.get('orderId','')))
  print('Symbol:   ' + str(r.get('symbol','')))
  print('Bracket:  ' + ('SET' if r.get('bracketSet') else 'PENDING'))
  print('Account:  ' + str(r.get('account','')))
else:
  print('ERROR: ' + str(d.get('error',d)))
"
  echo ""
fi

# ================================================================
# CLOSE -- close a position
# ================================================================
if [ "$COMMAND" = "close" ]; then
  CONTRACT=${2:-SPY}
  QTY=${3:-1}
  LIVE=${4:-sim}
  ACCOUNT="SIM3142118M"
  if [ "$LIVE" = "live" ]; then
    ACCOUNT="11975462"
  fi
  echo "Closing: $CONTRACT x$QTY on $ACCOUNT..."
  curl -s -X POST "$RAILWAY_URL/webhook/close" \
    -H "Content-Type: application/json" \
    -H "x-stratum-secret: $SECRET" \
    -d "{\"account\":\"$ACCOUNT\",\"symbol\":\"$CONTRACT\",\"qty\":$QTY}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('CLOSED OK' if d.get('status')=='OK' else 'ERROR: ' + str(d))
"
  echo ""
fi

# ================================================================
# EOD -- manually trigger end of day close
# ================================================================
if [ "$COMMAND" = "eod" ]; then
  echo "Triggering EOD close on live account..."
  curl -s -X POST "$RAILWAY_URL/webhook/execute" \
    -H "Content-Type: application/json" \
    -H "x-stratum-secret: $SECRET" \
    -d '{"action":"EOD_CLOSE","account":"11975462"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(str(d))
"
  echo ""
fi

# ================================================================
# IDEA -- submit John's idea
# bash stratum.sh idea PG put 143.21 2.13 1.44 3.41 4.69 live
# ================================================================
if [ "$COMMAND" = "idea" ]; then
  TICKER=${2:-PG}
  DIR=${3:-put}
  TRIGGER=${4:-0}
  ENTRY=${5:-0}
  STOP=${6:-0}
  T1=${7:-0}
  T2=${8:-0}
  LIVE=${9:-sim}
  IS_LIVE="false"
  if [ "$LIVE" = "live" ]; then IS_LIVE="true"; fi
  echo "Submitting idea: $TICKER $DIR trigger=\$$TRIGGER entry=\$$ENTRY..."
  curl -s -X POST "$RAILWAY_URL/webhook/idea" \
    -H "Content-Type: application/json" \
    -H "x-stratum-secret: $SECRET" \
    -d "{\"ticker\":\"$TICKER\",\"direction\":\"$DIR\",\"triggerPrice\":$TRIGGER,\"triggerType\":\"close_below\",\"entryPrice\":$ENTRY,\"stop\":$STOP,\"t1\":$T1,\"t2\":$T2,\"source\":\"John\",\"premium\":$ENTRY,\"contracts\":1,\"live\":$IS_LIVE}" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('IDEA ARMED' if d.get('status')=='OK' else 'ERROR: ' + str(d))
"
  echo ""
fi

# ================================================================
# SIM MODE
# ================================================================
if [ "$COMMAND" = "sim" ]; then
  ACTION=${2:-status}
  if [ "$ACTION" = "on" ]; then
    curl -s -X POST "$RAILWAY_URL/sim/enable" -H "x-stratum-secret: $SECRET"
    echo "SIM mode ENABLED -- all trades go to SIM account"
  elif [ "$ACTION" = "off" ]; then
    curl -s -X POST "$RAILWAY_URL/sim/disable" -H "x-stratum-secret: $SECRET"
    echo "SIM mode DISABLED -- trades go to LIVE account"
  else
    curl -s "$RAILWAY_URL/sim/status" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('SIM mode: ' + ('ENABLED' if d.get('simMode') else 'DISABLED'))
"
  fi
  echo ""
fi

# ================================================================
# MORNING -- trigger morning brief
# ================================================================
if [ "$COMMAND" = "morning" ]; then
  echo "Triggering morning brief..."
  curl -s -X POST "$RAILWAY_URL/trigger/morning" -H "x-stratum-secret: $SECRET"
  echo "Morning brief triggered -- check Discord #execute-now"
  echo ""
fi

# ================================================================
# JOURNAL -- trigger EOD journal
# ================================================================
if [ "$COMMAND" = "journal" ]; then
  echo "Triggering EOD journal..."
  curl -s -X POST "$RAILWAY_URL/trigger/journal" -H "x-stratum-secret: $SECRET"
  echo "Journal triggered -- check Discord #trading-journal"
  echo ""
fi

# ================================================================
# WIN RATE
# ================================================================
if [ "$COMMAND" = "winrate" ]; then
  curl -s "$RAILWAY_URL/win-rate" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('Win Rate: ' + str(round(d.get('winRate',0)*100,1)) + '%')
  print('Trades:   ' + str(d.get('totalTrades',0)))
  print('Wins:     ' + str(d.get('wins',0)))
  print('Losses:   ' + str(d.get('losses',0)))
  if d.get('totalTrades',0) >= 20 and d.get('winRate',0) >= 0.65:
    print('STATUS:   READY FOR LIVE')
  else:
    print('STATUS:   SIM testing in progress')
except: print('Could not parse win rate')
"
  echo ""
fi

# ================================================================
# AGENT STATE
# ================================================================
if [ "$COMMAND" = "agent" ]; then
  curl -s "$RAILWAY_URL/agent/state" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  for k,v in d.items():
    print(str(k) + ': ' + str(v))
except: print('Could not parse agent state')
"
  echo ""
fi

# ================================================================
# MACRO FILTER
# ================================================================
if [ "$COMMAND" = "macro" ]; then
  curl -s "$RAILWAY_URL/macro/status" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print('SPY:  \$' + str(d.get('spyPrice','unknown')))
  print('Bias: ' + str(d.get('bias','unknown')))
except: print('Could not parse macro')
"
  echo ""
fi

# ================================================================
# HOLD LOCK
# ================================================================
if [ "$COMMAND" = "hold" ]; then
  TICKER=${2:-SPY}
  DATE=${3:-2026-04-06}
  echo "Setting hold lock on $TICKER until $DATE..."
  curl -s -X POST "$RAILWAY_URL/hold/$TICKER/$DATE" -H "x-stratum-secret: $SECRET"
  echo ""
fi

# ================================================================
# OVERRIDE LOSS LIMIT (emergency only)
# ================================================================
if [ "$COMMAND" = "override" ]; then
  echo "WARNING: Overriding daily loss limit on live account..."
  curl -s -X POST "$RAILWAY_URL/loss-limit/override" \
    -H "Content-Type: application/json" \
    -H "x-stratum-secret: $SECRET" \
    -d '{"account":"11975462"}'
  echo ""
  echo "Loss limit override applied -- trading allowed again"
  echo ""
fi

echo "Done."
