#!/usr/bin/env python3
"""GST-24: detach the auth waiter so it survives this Hermes/Paperclip run."""
import os, subprocess, sys

SCRIPT = "/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher/scripts/gst24_auth_waiter.sh"
LOG = "/tmp/gst24_waiter_launch.log"
PIDFILE = "/tmp/gst24_waiter.pid"

# Single instance: refuse if a live waiter already exists
try:
    out = subprocess.run(["pgrep", "-f", "gst24_auth_waiter\\.sh$"],
                         capture_output=True, text=True)
    if out.stdout.strip():
        print(f"waiter already running: {out.stdout.strip()}")
        sys.exit(0)
except Exception:
    pass

env = {"PATH": "/Users/prajwalmendonca/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin",
       "HOME": os.path.expanduser("~"), "TERM": "dumb"}
log = open(LOG, "ab", buffering=0)
p = subprocess.Popen(["/bin/bash", SCRIPT], stdout=log, stderr=log,
                     stdin=subprocess.DEVNULL, cwd="/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher",
                     env=env, start_new_session=True, close_fds=True)
with open(PIDFILE, "w") as f:
    f.write(str(p.pid))
print(f"launched pid={p.pid} detached=True")
