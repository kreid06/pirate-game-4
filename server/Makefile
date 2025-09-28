# Compiler
CC = gcc
CFLAGS = -Wall -Wextra -std=c99 -O2 -g
INCLUDES = -Iinclude
LIBS = -lwebsockets -ljson-c -lm -lpthread

# Directories
SRCDIR = src
INCDIR = include
OBJDIR = obj
BINDIR = bin

# Source files (excluding duplicates and test files)
CORE_SOURCES = $(filter-out $(SRCDIR)/core/server.c, $(wildcard $(SRCDIR)/core/*.c)) $(wildcard $(SRCDIR)/sim/*.c) $(wildcard $(SRCDIR)/util/*.c)
NET_SOURCES = $(SRCDIR)/net/network.c $(SRCDIR)/net/protocol.c $(SRCDIR)/net/reliability.c $(SRCDIR)/net/snapshot.c
AOI_SOURCES = $(wildcard $(SRCDIR)/aoi/*.c)
ADMIN_SOURCES = $(SRCDIR)/admin/admin_server.c $(SRCDIR)/admin/admin_api.c
MAIN_SOURCES = $(SRCDIR)/main.c $(SRCDIR)/server.c

SOURCES = $(CORE_SOURCES) $(NET_SOURCES) $(AOI_SOURCES) $(ADMIN_SOURCES) $(MAIN_SOURCES)
OBJECTS = $(SOURCES:$(SRCDIR)/%.c=$(OBJDIR)/%.o)
TARGET = $(BINDIR)/pirate-server

# Default target
all: $(TARGET)

# Create directories
$(OBJDIR):
	mkdir -p $(OBJDIR)

$(BINDIR):
	mkdir -p $(BINDIR)

# Build target
# Libraries 
LIBS = -lm -lpthread
OPTIONAL_LIBS = -lwebsockets -ljson-c

# Link the target
$(TARGET): $(OBJECTS) | $(BINDIR)
	$(CC) $(OBJECTS) -o $@ $(LIBS)

# Alternative target with optional libraries  
$(TARGET)-full: $(OBJECTS) | $(BINDIR)
	$(CC) $(OBJECTS) -o $@ $(LIBS) $(OPTIONAL_LIBS)

# Compile source files
$(OBJDIR)/%.o: $(SRCDIR)/%.c | $(OBJDIR)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) $(INCLUDES) -c $< -o $@

# Clean
clean:
	rm -rf $(OBJDIR) $(BINDIR)

# Install dependencies (Ubuntu/Debian)
install-deps:
	sudo apt-get update
	sudo apt-get install -y build-essential libwebsockets-dev libjson-c-dev

.PHONY: all clean install-deps test-integration demo-simple

# Full integration test for Week 3-4 systems
test-integration: obj/core/rewind_buffer.o obj/core/input_validation.o obj/core/math.o obj/core/rng.o
	gcc -Wall -Wextra -std=c99 -O2 -g -Iinclude -o bin/test_full_integration test_full_integration.c $^ -lm -lrt

# Simple Week 3-4 demonstration
demo-simple: obj/core/rewind_buffer.o obj/core/input_validation.o obj/core/math.o obj/core/rng.o
	gcc -Wall -Wextra -std=c99 -O2 -g -Iinclude -o bin/simple_week3_4_demo simple_week3_4_demo.c $^ -lm -lrt