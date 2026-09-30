#!/usr/bin/env python3
"""GST-24: launch the supervisor detached, inheriting the CURRENT run env
(PAPERCLIP_* vars) so its wakeup call can authenticate after this run ends.
Single instance: refuses if a live supervisor already exists."""
import os, subprocess, sys

SCRIPT = "/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher/scripts/gst24_supervisor.sh"
LOG = "/tmp/gst24_supervisor_launch.log"

try:
    out = subprocess.run(["pgrep", "-f", "gst24_supervisor\\.sh"],
                         capture_output=True, text=True)
    if out.stdout.strip():
        print(f"supervisor already running: {out.stdout.strip()}")
        sys.exit(0)
except Exception:
    pass

env = dict(os.environ)  # inherit PAPERCLIP_* from this terminal session
env["PATH"] = "/Users/prajwalmendonca/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:" + env.get("PATH", "")
log = open(LOG, "", buffering=0) if False else open(LOG, "ab", buffering=0)
p = subprocess.Popen(["/bin/bash", SCRIPT], stdout=log, stderr=log,
                     stdin=subprocess.DEVNULL,
                     cwd="/Users/prajwalmendonca/Dolly/paperclip/yield-pool-watcher",
                     env=env, start_new_session=True, close_fds=True)
print(f"launched pid={p.pid} detached=True env_has_key={'PAPERCLIP_API_KEY' in env}")
