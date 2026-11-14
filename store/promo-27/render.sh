#!/bin/zsh
# Renders the six v2 promo images (Chromium) under the heavy lock, then finish.py: 1024×1024 RGB PNGs,
# manifest.json and compare-sheet.jpg.
L=/Users/alexandrlubchenko/AI_sidebar/.claude/heavy.lock
if ! mkdir $L 2>/dev/null; then echo "BUSY: $(cat $L/owner 2>/dev/null)"; exit 0; fi
echo "store-pages: 2.7 promo images v2 (Chromium)" > $L/owner
cleanup() { rm -f $L/owner; rmdir $L 2>/dev/null; echo released; }
trap cleanup EXIT
V=~/ContextFlow-work/store-pages/promo-27/v2
S=~/ContextFlow-work/store-pages/shots26r
B=~/ContextFlow-work/store-pages/banners261
PW=~/ContextFlow-work/store-pages/pw
cp $V/promo2.mjs $V/boxes.json $PW/
cd $PW && node promo2.mjs $S/raw-en $B/raw-en $V || exit 1
python3 $V/finish.py $V
