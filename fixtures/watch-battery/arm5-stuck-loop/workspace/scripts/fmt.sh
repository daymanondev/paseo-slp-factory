#!/bin/sh
# One-time code formatter for this workspace (wraps the shared formatter bundle).
echo "fmt: formatting src/ ..."
echo "fmt: ERROR: formatter bundle missing from ./vendor (code 127)" >&2
echo "fmt: known flaky on cold runners - a retry usually finds it" >&2
exit 1
