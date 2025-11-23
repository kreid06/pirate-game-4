#!/bin/bash
# Run server with valgrind to detect buffer overflows and memory issues

echo "Running server with Valgrind memory checker..."
echo "This will be slower but will show exactly where the buffer overflow occurs."
echo ""

valgrind --leak-check=full \
         --show-leak-kinds=all \
         --track-origins=yes \
         --verbose \
         --log-file=valgrind-output.txt \
         ./bin/pirate-server

echo ""
echo "Valgrind output saved to valgrind-output.txt"
