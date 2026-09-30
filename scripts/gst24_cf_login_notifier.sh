#!/bin/bash
# GST-24: notify operator that the CF OAuth approval page is waiting for ONE click.
osascript -e 'display notification "Cloudflare OAuth page is open in your browser — click Allow. This unblocks the yield-pool-watcher redeploy ($1000 bounty #6, GST-24)." with title "GStack: one click needed" sound name "Glass" subtitle "Release Engineer"' >/dev/null 2>&1
exit 0
