#!/bin/bash
cd /home/kavaniih/Documents/EventContracts1/backend
ADDR=0xbe61a15b91676d019090e63190dc49d73044e202
for i in $(seq 1 20); do
  npx tsx quantwatch.mjs 2>&1 | tail -2
  sleep 45
done
echo "=== FINAL TALLY ==="
curl -s "http://localhost:8787/api/bots/af6a19dd-b273-4313-8204-50b335abc05b/activity?address=$ADDR" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);
const today=d.orders.filter(o=>o.placedAt*1000>Date.parse("2026-08-29T00:00:00Z"));
const dec=today.filter(o=>o.won!==null);
console.log("today:",today.length,"orders |",dec.length,"settled |",dec.filter(o=>o.won).length,"won | net",dec.reduce((a,o)=>a+o.pnl,0).toFixed(2));
console.log("balance",d.balance?.toFixed(2),"| affordable",d.affordable,"| cap allows",d.bot.dailyTrades-d.bot.tradesToday);
for(const o of today)
  console.log("  ",new Date(o.placedAt*1000).toISOString().slice(11,16),(o.outcomeIndex===0?"UP  ":"DOWN"),
    "paid "+(o.filled>0?Math.round(o.price*100)+"c":"--"),o.status.padEnd(8),
    o.won===null?"pending":(o.won?"Won  +"+o.pnl.toFixed(2):"Lost "+o.pnl.toFixed(2)));});'
