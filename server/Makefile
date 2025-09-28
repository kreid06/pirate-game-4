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

# Source files
SOURCES = $(wildcard $(SRCDIR)/**/*.c $(SRCDIR)/*.c)
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
$(TARGET): $(OBJECTS) | $(BINDIR)
	$(CC) $(OBJECTS) -o $@ $(LIBS)

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