#!/bin/sh
# docmd Docker healthcheck
#
# `docmd serve` listens on exactly one port (PORT, default 3000) and answers
# GET /healthz with {"status":"ok","version":"..."} once the site is built
# (503 while it is still building). Returns 0 only on a 2xx response.
curl -fs --connect-timeout 2 "http://127.0.0.1:${PORT:-3000}/healthz" >/dev/null 2>&1 || exit 1
