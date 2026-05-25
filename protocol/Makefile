# protocol/Makefile — regenerate shared asset headers from JSON
#
# Usage:
#   make          (from protocol/)  — regenerates all outputs
#   make codegen  (from repo root)  — via root Makefile target

CODEGEN = python3 $(CURDIR)/codegen.py
SRC     = $(CURDIR)/ship_definitions.json
OUT_C   = $(CURDIR)/ship_definitions.h
OUT_TS  = $(CURDIR)/../client/src/common/ShipDefinitions.ts

.PHONY: all clean

all: $(OUT_C) $(OUT_TS)

$(OUT_C) $(OUT_TS): $(SRC) $(CURDIR)/codegen.py
	$(CODEGEN)

clean:
	@echo "Outputs are generated — delete manually if needed."
